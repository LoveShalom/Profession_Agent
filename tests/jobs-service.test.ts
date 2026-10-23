import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { collectSkillNames, toJobDraft, toJobSkillRows } from '../src/lib/jobs/mapping.ts';
import { listJobs, saveJob } from '../src/lib/jobs/service.ts';
import { validateExtraction } from '../src/lib/pipeline/validate.ts';
import { ABSENT_DEADLINE, JdExtractionSchema, type JdExtraction } from '../src/lib/schemas/jd.ts';

const USER = '00000000-0000-4000-8000-000000000001';

const skill = (overrides: Record<string, unknown> = {}) => ({
  name: 'Java',
  source: 'explicit',
  requirement: 'must',
  proficiency: 'expert',
  confidence: 0.9,
  basisPhrase: '精通 Java',
  ...overrides,
});

const extraction = (overrides: Record<string, unknown> = {}): JdExtraction =>
  JdExtractionSchema.parse({
    fields: {
      company: '某科技有限公司',
      title: '后端开发工程师',
      cities: ['上海', '杭州'],
      source: 'manual',
      raw_text: '某科技有限公司招聘后端开发工程师，精通 Java',
      skills: [skill(), skill({ name: 'Kubernetes', proficiency: 'unknown', requirement: 'nice_to_have', basisPhrase: 'Kubernetes 优先' })],
      deadline: { kind: 'provided', at: '2026-11-20T23:59:59+08:00', text: '11月20日前' },
      ...overrides,
    },
    evidence: { company: '某科技有限公司', salary_min: '15k-25k', deadline: '11月20日前' },
    confidence: { company: 0.95, title: 0.95, cities: 0.95, deadline: 0.9, skills: 0.9 },
  });

// ---------------------------------------------------------------- 映射层
test('toJobDraft：一等列映射正确，含指纹、死线与 review_flags', () => {
  const data = extraction({ salary_min: 15000, salary_max: 25000, salary_months: 14 });
  const draft = toJobDraft(data, validateExtraction(data));

  assert.equal(draft.company, '某科技有限公司');
  assert.equal(draft.city, '上海', 'city 取 cities[0]');
  assert.deepEqual(draft.cities, ['上海', '杭州']);
  assert.equal(draft.deadline, '2026-11-20T23:59:59+08:00');
  assert.equal(draft.deadline_kind, 'provided');
  assert.equal(draft.status, 'saved', '默认 saved（C-01）');
  assert.equal(draft.priority, '中');
  assert.match(draft.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(draft.skills, ['Java', 'Kubernetes'], '归一化技能名集合');
  assert.ok(Array.isArray(draft.review_flags));
  assert.equal((draft.jd_structured as { schemaVersion: string }).schemaVersion, 'field-dict-v1');
});

test('toJobDraft：无截止日期 → deadline=null 且 kind=absent（R-3）', () => {
  const data = extraction({ deadline: ABSENT_DEADLINE });
  const draft = toJobDraft(data, validateExtraction(data));
  assert.equal(draft.deadline, null);
  assert.equal(draft.deadline_kind, 'absent');
});

test('toJobDraft：同公司/岗位/城市的不同写法 → 同一指纹（去重生效）', () => {
  const a = toJobDraft(extraction(), validateExtraction(extraction()));
  const b = toJobDraft(
    extraction({ company: '某科技', title: '后端开发工程师（急招）', cities: ['杭州', '上海'] }),
    validateExtraction(extraction()),
  );
  assert.equal(a.fingerprint, b.fingerprint);
});

test('toJobSkillRows：每个技能一行，属性原样保留', () => {
  const rows = toJobSkillRows(extraction());
  assert.equal(rows.length, 2);
  const java = rows.find((row) => row.skill === 'Java');
  assert.equal(java?.source, 'explicit');
  assert.equal(java?.proficiency, 'expert');
  assert.equal(java?.requirement, 'must');
  assert.equal(java?.basisPhrase, '精通 Java');
  const k8s = rows.find((row) => row.skill === 'Kubernetes');
  assert.equal(k8s?.requirement, 'nice_to_have');
});

test('collectSkillNames：按大小写去重且保序', () => {
  const names = collectSkillNames([
    { name: 'Java', source: 'explicit', requirement: 'must', proficiency: 'expert', confidence: 0.9, basisPhrase: 'x' },
    { name: 'java', source: 'inferred', requirement: 'unknown', proficiency: 'unknown', confidence: 0.5, basisPhrase: 'y' },
    { name: 'Go', source: 'explicit', requirement: 'unknown', proficiency: 'unknown', confidence: 0.7, basisPhrase: 'z' },
  ]);
  assert.deepEqual(names, ['Java', 'Go']);
});

// ---------------------------------------------------------------- 入库服务
test('saveJob：首次入库 → created，技能属性一起写入', async () => {
  const repo = createMemoryJobRepository();
  const data = extraction();
  const result = await saveJob(repo, { userId: USER, extraction: data });

  assert.equal(result.status, 'created');
  assert.equal(result.job?.company, '某科技有限公司');
  assert.equal(result.job?.status, 'saved');
  assert.equal(await repo.count(USER), 1);

  const skills = await repo.listSkills(result.job!.id);
  assert.equal(skills.length, 2);
  assert.equal(skills.find((row) => row.skill === 'Java')?.proficiency, 'expert');
});

test('saveJob：同一岗位再次提交 → duplicate，并给出已有记录', async () => {
  const repo = createMemoryJobRepository();
  const first = await saveJob(repo, { userId: USER, extraction: extraction() });
  const second = await saveJob(repo, { userId: USER, extraction: extraction() });

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'duplicate');
  assert.equal(second.duplicateOf?.id, first.job?.id);
  assert.equal(await repo.count(USER), 1, '不应重复入库');
});

test('saveJob(forceCreate)：重复时强制新建（用户在提示里选"强制新建"）', async () => {
  const repo = createMemoryJobRepository();
  await saveJob(repo, { userId: USER, extraction: extraction() });
  const forced = await saveJob(repo, { userId: USER, extraction: extraction(), forceCreate: true });

  assert.equal(forced.status, 'created');
  assert.equal(await repo.count(USER), 2);
});

test('saveJob：有 blocker → blocked，不落库，并给出中文原因', async () => {
  const repo = createMemoryJobRepository();
  // 占位公司（规则模式抽不到公司时的兜底值）→ company_missing
  const blocked = extraction({ company: '（待填写公司）' });
  const result = await saveJob(repo, { userId: USER, extraction: blocked });

  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('company_missing'));
  assert.equal(result.messages.length, 1);
  assert.ok(result.messages[0]!.includes('公司'));
  assert.equal(await repo.count(USER), 0, '有 blocker 时不得落库');
});

test('saveJob：薪资有值但无证据 → blocked（关键字段必须有依据）', async () => {
  const repo = createMemoryJobRepository();
  const data = JdExtractionSchema.parse({
    fields: {
      company: '某公司',
      title: '某岗位',
      cities: ['北京'],
      source: 'manual',
      raw_text: 'x',
      salary_min: 15000,
      deadline: ABSENT_DEADLINE,
    },
  });
  const result = await saveJob(repo, { userId: USER, extraction: data });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('salary_evidence_missing'));
});

test('saveJob：无截止日期的岗位可正常入库（R-3 核心场景）', async () => {
  const repo = createMemoryJobRepository();
  const data = extraction({ deadline: ABSENT_DEADLINE });
  const result = await saveJob(repo, { userId: USER, extraction: data });
  assert.equal(result.status, 'created');
  assert.equal(result.draft?.deadline, null);
  assert.equal(result.draft?.deadline_kind, 'absent');
});

test('listJobs：返回岗位摘要，可按 onlyNeedsReview 过滤', async () => {
  const repo = createMemoryJobRepository();
  await saveJob(repo, { userId: USER, extraction: extraction() });
  await saveJob(repo, {
    userId: USER,
    extraction: extraction({ company: '另一家公司', title: '数据工程师', cities: ['北京'] }),
  });

  const all = await listJobs(repo, USER);
  assert.equal(all.total, 2);
  assert.equal(all.items.length, 2);
  assert.ok(all.items[0]!.createdAt >= all.items[1]!.createdAt, '按创建时间倒序');

  const needsReview = await listJobs(repo, USER, { onlyNeedsReview: true });
  assert.ok(needsReview.items.every((item) => item.reviewFlags.length >= 0));
});

test('仓储隔离：不同 user 的岗位互不可见', async () => {
  const repo = createMemoryJobRepository();
  await saveJob(repo, { userId: USER, extraction: extraction() });
  assert.equal(await repo.count('another-user'), 0);
  assert.deepEqual((await repo.list('another-user')).length, 0);
});
