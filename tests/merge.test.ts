import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { mergeDuplicateJob } from '../src/lib/jobs/merge.ts';
import { saveJob } from '../src/lib/jobs/service.ts';
import { ABSENT_DEADLINE, JdExtractionSchema } from '../src/lib/schemas/jd.ts';

const USER = '00000000-0000-4000-8000-000000000001';

function extraction(overrides: { raw_text?: string; salary?: boolean; deadline?: boolean } = {}) {
  const salary = overrides.salary
    ? { salary_min: 20, salary_max: 30 }
    : {};
  const deadline = overrides.deadline
    ? { kind: 'provided' as const, at: '2026-12-01T23:59:59+08:00', text: null }
    : ABSENT_DEADLINE;
  const evidence: Record<string, string> = {};
  if (overrides.salary) {
    evidence.salary_min = '月薪 20-30K';
  }
  if (overrides.deadline) {
    evidence.deadline = '截止 2026-12-01';
  }
  return JdExtractionSchema.parse({
    fields: {
      company: '某科技有限公司',
      title: '后端开发工程师',
      cities: ['上海'] as string[],
      source: 'manual',
      raw_text: overrides.raw_text ?? '某科技有限公司招聘后端开发工程师',
      deadline,
      ...salary,
    },
    evidence,
  });
}

async function seed() {
  const repo = createMemoryJobRepository();
  const saved = await saveJob(repo, { userId: USER, extraction: extraction() });
  assert.equal(saved.status, 'created');
  return { repo, jobId: saved.job!.id };
}

test('合并重复 JD：补齐旧值为空的字段 + 原文追加 + 事件留痕', async () => {
  const { repo, jobId } = await seed();
  const before = await repo.findById(USER, jobId);

  const result = await mergeDuplicateJob(repo, {
    userId: USER,
    jobId,
    extraction: extraction({ raw_text: '另一份 JD：某科技有限公司招聘后端开发工程师（含薪资）', salary: true }),
  });

  assert.equal(result.status, 'merged');
  assert.ok(result.filled.includes('薪资下限'));
  assert.ok(result.filled.includes('薪资上限'));

  const after = await repo.findById(USER, jobId);
  assert.equal(after!.salary_min, 20);
  assert.equal(after!.salary_max, 30);
  assert.ok(after!.raw_text.includes('另一份 JD'));
  assert.ok(after!.raw_text.includes('【另一份重复 JD 原文】'), '追加时保留分隔符与原文');
  assert.equal(after!.company, before!.company, '公司不被覆盖');

  const events = await repo.listEvents(USER, jobId);
  assert.equal(events.length, 1);
  assert.match(events[0]!.note ?? '', /合并重复 JD/);
  assert.equal(events[0]!.fromStatus, events[0]!.toStatus, '合并不改状态');
});

test('合并重复 JD：没有可补齐字段时返回 no_change 仍追加原文', async () => {
  const { repo, jobId } = await seed();
  // 先合并一次把薪资补上
  await mergeDuplicateJob(repo, { userId: USER, jobId, extraction: extraction({ salary: true }) });

  const again = await mergeDuplicateJob(repo, {
    userId: USER,
    jobId,
    extraction: extraction({ raw_text: '第三份原文', salary: true }),
  });
  assert.equal(again.status, 'no_change');
  const after = await repo.findById(USER, jobId);
  assert.ok(after!.raw_text.includes('第三份原文'));
});

test('合并重复 JD：目标不存在 → not_found', async () => {
  const { repo } = await seed();
  const result = await mergeDuplicateJob(repo, {
    userId: USER,
    jobId: '00000000-0000-4000-8000-0000000000ff',
    extraction: extraction(),
  });
  assert.equal(result.status, 'not_found');
});
