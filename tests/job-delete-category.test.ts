import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { deriveJobCategory } from '../src/lib/jobs/category.ts';
import { listJobs, saveJob } from '../src/lib/jobs/service.ts';
import { ABSENT_DEADLINE, JdExtractionSchema } from '../src/lib/schemas/jd.ts';

const USER = '00000000-0000-4000-8000-000000000001';

function extraction(company: string, title: string, skills: string[], rawText: string) {
  return JdExtractionSchema.parse({
    fields: {
      company,
      title,
      cities: ['上海'],
      source: 'manual',
      raw_text: rawText,
      deadline: ABSENT_DEADLINE,
      skills: skills.map((name) => ({
        name,
        source: 'explicit',
        requirement: 'unknown',
        proficiency: 'unknown',
        confidence: 0.7,
        basisPhrase: `熟悉 ${name}`,
      })),
    },
  });
}

async function seed() {
  const repo = createMemoryJobRepository();
  const created = await saveJob(repo, {
    userId: USER,
    extraction: extraction('示例医学科技有限公司', '医学影像算法工程师', ['Python', 'PyTorch'], '负责 MRI 影像分割与病灶检测'),
  });
  assert.equal(created.status, 'created');
  return { repo, jobId: created.job!.id };
}

test('新建岗位自动派生分类：医学影像', async () => {
  const { repo, jobId } = await seed();
  const job = await repo.findById(USER, jobId);
  assert.equal(job!.category, 'algo-medical-imaging');
});

test('列表可按分类筛选；includeDeleted 控制软删除可见性', async () => {
  const { repo, jobId } = await seed();
  const byCategory = await listJobs(repo, USER, { category: 'algo-medical-imaging' });
  assert.equal(byCategory.items.length, 1);
  assert.equal(byCategory.items[0]!.category, 'algo-medical-imaging');
  assert.equal((await listJobs(repo, USER, { category: 'backend' })).items.length, 0);

  // 软删除
  assert.equal(await repo.softDelete(USER, jobId), true);
  assert.equal((await listJobs(repo, USER, {})).items.length, 0, '默认不含已删除');
  const withDeleted = await listJobs(repo, USER, { includeDeleted: true });
  assert.equal(withDeleted.items.length, 1);
  assert.notEqual(withDeleted.items[0]!.deletedAt, null);

  // 恢复
  assert.equal(await repo.restore(USER, jobId), true);
  assert.equal((await listJobs(repo, USER, {})).items.length, 1);
  // 重复删除/恢复返回 false（幂等语义）
  assert.equal(await repo.softDelete(USER, jobId), true);
  assert.equal(await repo.softDelete(USER, jobId), false);
  assert.equal(await repo.restore(USER, jobId), true);
  assert.equal(await repo.restore(USER, jobId), false);
});

test('手动覆盖定位：可以按有效定位筛选；PATCH 白名单接受 campaignTier', async () => {
  const { repo, jobId } = await seed();
  // 默认：医学影像 → primary
  assert.equal((await listJobs(repo, USER, { tier: 'primary' })).items.length, 1);
  assert.equal((await listJobs(repo, USER, { tier: 'casual' })).items.length, 0);

  // 手动改成碰运气
  const updated = await repo.update(USER, jobId, { campaignTier: 'casual' });
  assert.equal(updated!.campaignTier, 'casual');
  assert.equal((await listJobs(repo, USER, { tier: 'primary' })).items.length, 0);
  const casual = await listJobs(repo, USER, { tier: 'casual' });
  assert.equal(casual.items.length, 1);
  assert.equal(casual.items[0]!.tierOverridden, true);

  // 清空覆盖 → 跟随分类
  await repo.update(USER, jobId, { campaignTier: null });
  assert.equal((await listJobs(repo, USER, { tier: 'primary' })).items.length, 1);
});

test('resolveJobPatch：campaignTier 只接受三值或 null', async () => {
  const { resolveJobPatch } = await import('../src/lib/jobs/service.ts');
  assert.deepEqual(resolveJobPatch({ campaignTier: 'primary' }), { ok: true, patch: { campaignTier: 'primary' } });
  assert.deepEqual(resolveJobPatch({ campaignTier: null }), { ok: true, patch: { campaignTier: null } });
  assert.equal(resolveJobPatch({ campaignTier: 'urgent' }).ok, false);
});

test('用户手改分类后，再派生也不会被自动覆盖（由调用方决定）', async () => {
  const { repo, jobId } = await seed();
  const updated = await repo.update(USER, jobId, { category: 'algo-llm' });
  assert.equal(updated!.category, 'algo-llm');
  // deriveJobCategory 是纯函数，不会写库；这里验证"派生结果仍可能不同，是否覆盖由 backfill 决定"
  assert.equal(deriveJobCategory({ title: '医学影像算法工程师' }).code, 'algo-medical-imaging');
  assert.equal((await repo.findById(USER, jobId))!.category, 'algo-llm', '库里的手改值保持不变');
});
