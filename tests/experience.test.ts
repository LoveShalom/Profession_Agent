import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryExperienceRepository, listExperiences, saveExperience, toDateColumn } from '../src/lib/experience/service.ts';
import {
  experienceDedupeKey,
  extractDates,
  extractExperienceFromText,
  extractMetrics,
  extractOrg,
} from '../src/lib/pipeline/experience.ts';
import { ExperienceFormSchema, isResumeReady, type ExperienceForm } from '../src/lib/schemas/experience.ts';

const USER = '00000000-0000-4000-8000-000000000001';

function form(overrides: Partial<ExperienceForm> = {}): ExperienceForm {
  return ExperienceFormSchema.parse({
    type: 'internship',
    org: '某科技有限公司',
    role: '后端开发实习生',
    startDate: '2026-06',
    endDate: '2026-09',
    summary: '参与订单系统的后端开发',
    star: {
      situation: '订单系统在大促期间超时',
      task: '需要把 P99 延迟降到 200ms 以内',
      action: '重写查询并加缓存、分库分表',
      result: 'P99 从 800ms 降到 180ms，支撑 2 倍流量',
    },
    skills: ['Java', 'MySQL', 'Redis'],
    metrics: [{ metric: '耗时(ms)', value: 180, unit: 'ms', raw: 'P99 从 800ms 降到 180ms' }],
    evidenceUrls: [],
    rawText: '',
    ...overrides,
  });
}

// ---------------------------------------------------------------- 规则抽取
test('extractExperienceFromText：识别小节标记 → STAR 四段', () => {
  const text = [
    '在某某科技有限公司实习，担任后端开发实习生，时间 2026年6月 到 2026年9月。',
    '背景：订单系统在大促期间频繁超时。',
    '任务：把 P99 延迟降到 200ms 以内。',
    '行动：重写核心查询、引入 Redis 缓存、按用户分库分表。',
    '结果：P99 从 800ms 降到 180ms，支撑 2 倍流量，提升 30% 吞吐。',
  ].join('\n');

  const result = extractExperienceFromText(text);
  assert.equal(result.org, '某某科技有限公司');
  assert.equal(result.role, '后端开发实习生');
  assert.equal(result.type, 'internship');
  assert.equal(result.startDate, '2026-06');
  assert.equal(result.endDate, '2026-09');
  assert.ok(result.star.situation.includes('超时'));
  assert.ok(result.star.task.includes('200ms'));
  assert.ok(result.star.action.includes('Redis'));
  assert.ok(result.star.result.includes('180ms'));
  assert.ok(result.skills.includes('Redis'));
  assert.ok(result.metrics.some((metric) => metric.value === 180 && metric.unit === 'ms'));
  assert.ok(result.confidence > 0.5);
});

test('extractExperienceFromText：无小节标记时不编造，原文进 action', () => {
  const result = extractExperienceFromText('帮实验室做数据清洗的脚本，用 Python 处理了日志。');
  assert.equal(result.star.situation, '');
  assert.equal(result.star.result, '');
  assert.ok(result.star.action.includes('Python'));
  assert.equal(result.type, 'research', '识别到「实验室」应为科研');
});

test('extractExperienceFromText：空泛描述也给低置信度', () => {
  const result = extractExperienceFromText('参与了一个项目，做了些开发工作，效果不错。');
  assert.ok(result.confidence < 0.8);
  assert.equal(result.metrics.length, 0, '没有数字就不编造指标');
});

test('extractMetrics：只认有明确数字的说法，且去重', () => {
  const metrics = extractMetrics('P99 降到 180ms，吞吐提升 30%，覆盖 200 万用户。另外还提升了 30%。');
  assert.ok(metrics.some((item) => item.value === 180 && item.unit === 'ms'));
  assert.ok(metrics.some((item) => item.value === 30 && item.unit === '%'));
  assert.ok(metrics.some((item) => item.value === 200 && item.unit === '万'));
  assert.equal(metrics.filter((item) => item.unit === '%').length, 1, '同值同单位只保留一条');
});

test('extractOrg / extractDates：认不到就留空', () => {
  assert.equal(extractOrg('没有任何组织名的描述'), '');
  assert.deepEqual(extractDates('没有日期'), { startDate: null, endDate: null });
  assert.deepEqual(extractDates('2025年3月到2025年12月'), { startDate: '2025-03', endDate: '2025-12' });
});

test('experienceDedupeKey：组织/角色/起始月归一后相同', () => {
  assert.equal(
    experienceDedupeKey({ org: '某科技 有限公司', role: '后端开发', startDate: '2026-06-15' }),
    experienceDedupeKey({ org: '某科技有限公司', role: '后端 开发', startDate: '2026-06' }),
  );
});

// ---------------------------------------------------------------- 契约校验
test('ExperienceFormSchema：结束早于开始 / 全空 会被拒绝', () => {
  const bad = ExperienceFormSchema.safeParse({
    type: 'internship',
    org: '某公司',
    startDate: '2026-09',
    endDate: '2026-06',
    star: { situation: '', task: '', action: '', result: '' },
    summary: '',
  });
  assert.equal(bad.success, false);
  if (!bad.success) {
    const paths = bad.error.issues.map((issue) => issue.path.join('.'));
    assert.ok(paths.includes('endDate'));
    assert.ok(paths.includes('summary'));
  }
});

test('isResumeReady：行动与结果都有才够格', () => {
  assert.equal(isResumeReady({ star: { situation: 'a', task: 'b', action: 'c', result: 'd' } }), true);
  assert.equal(isResumeReady({ star: { situation: 'a', task: 'b', action: '', result: 'd' } }), false);
});

// ---------------------------------------------------------------- 服务层
test('saveExperience：新建 → 重复 → forceCreate 强制新建', async () => {
  const repo = createMemoryExperienceRepository();
  const first = await saveExperience(repo, { userId: USER, form: form() });
  assert.equal(first.status, 'created');

  const second = await saveExperience(repo, { userId: USER, form: form({ summary: '补充说明' }) });
  assert.equal(second.status, 'duplicate');
  assert.equal(second.duplicateOf?.id, first.experience.id);

  const forced = await saveExperience(repo, { userId: USER, form: form(), forceCreate: true });
  assert.equal(forced.status, 'created');
  assert.equal((await repo.list(USER)).length, 2);
});

test('saveExperience：带 id 时为更新', async () => {
  const repo = createMemoryExperienceRepository();
  const created = await saveExperience(repo, { userId: USER, form: form() });
  const updated = await saveExperience(repo, {
    userId: USER,
    id: created.experience.id,
    form: form({ role: '后端开发（转正）' }),
  });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.experience.role, '后端开发（转正）');
});

test('软删除与恢复：默认列表过滤已删，恢复后回来', async () => {
  const repo = createMemoryExperienceRepository();
  const created = await saveExperience(repo, { userId: USER, form: form() });
  assert.equal(await repo.softDelete(USER, created.experience.id), true);
  assert.equal((await listExperiences(repo, USER)).total, 0);
  assert.equal((await listExperiences(repo, USER, { includeDeleted: true })).total, 1);
  assert.equal(await repo.restore(USER, created.experience.id), true);
  assert.equal((await listExperiences(repo, USER)).total, 1);
});

test('listExperiences：统计"可用于生成简历"的经历数', async () => {
  const repo = createMemoryExperienceRepository();
  await saveExperience(repo, { userId: USER, form: form() });
  await saveExperience(repo, {
    userId: USER,
    form: form({
      org: '某实验室',
      type: 'research',
      star: { situation: '课题', task: '目标', action: '', result: '' },
    }),
  });
  const result = await listExperiences(repo, USER);
  assert.equal(result.total, 2);
  assert.equal(result.resumeReady, 1, '只有行动+结果齐全的那条算可用');
});

test('用户隔离：不同 user 互不可见', async () => {
  const repo = createMemoryExperienceRepository();
  await saveExperience(repo, { userId: USER, form: form() });
  assert.equal((await repo.list('another-user')).length, 0);
});

test('toDateColumn：YYYY-MM 写入 date 列前补 -01（Postgres 不接受裸年月）', () => {
  assert.equal(toDateColumn('2023-09'), '2023-09-01');
  assert.equal(toDateColumn('2026-06'), '2026-06-01');
  assert.equal(toDateColumn('2026-06-15'), '2026-06-15');
  assert.equal(toDateColumn(null), null);
  assert.equal(toDateColumn(''), null);
  assert.equal(toDateColumn('至今'), null, '认不出就留空，不塞脏值');
});
