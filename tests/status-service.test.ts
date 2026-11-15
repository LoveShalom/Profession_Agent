import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { listJobs, saveJob } from '../src/lib/jobs/service.ts';
import { listJobTimeline, transitionJobStatus } from '../src/lib/jobs/status-service.ts';
import { JdExtractionSchema, ABSENT_DEADLINE } from '../src/lib/schemas/jd.ts';

const USER = '00000000-0000-4000-8000-000000000001';

const extraction = (overrides: Record<string, unknown> = {}) =>
  JdExtractionSchema.parse({
    fields: {
      company: '某科技有限公司',
      title: '后端开发工程师',
      cities: ['上海'],
      source: 'manual',
      raw_text: '某科技有限公司招聘后端开发工程师，熟悉 Java',
      deadline: ABSENT_DEADLINE,
      ...overrides,
    },
  });

async function seed(): Promise<{ repo: ReturnType<typeof createMemoryJobRepository>; jobId: string }> {
  const repo = createMemoryJobRepository();
  const saved = await saveJob(repo, { userId: USER, extraction: extraction() });
  assert.equal(saved.status, 'created');
  return { repo, jobId: saved.job!.id };
}

// ---------------------------------------------------------------- 正常流转
test('状态流转：前进写事件，返回 updated + from/to', async () => {
  const { repo, jobId } = await seed();
  const outcome = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.status, 'updated');
  assert.equal(outcome.from, 'saved');
  assert.equal(outcome.to, 'applied');
  assert.equal(outcome.kind, 'forward');
  assert.equal(outcome.job.status, 'applied');
  assert.equal(outcome.event?.fromStatus, 'saved');
  assert.equal(outcome.event?.isRollback, false);
  assert.equal(outcome.event?.isReactivation, false);
});

test('状态流转：跨步前进允许（applied → interviewing）', async () => {
  const { repo, jobId } = await seed();
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  const outcome = await transitionJobStatus(repo, { userId: USER, jobId, to: 'interviewing' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.job.status, 'interviewing');
});

test('状态流转：同状态幂等，不写事件', async () => {
  const { repo, jobId } = await seed();
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  const outcome = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.status, 'unchanged');
  const events = await repo.listEvents(USER, jobId);
  assert.equal(events.length, 1, '同状态不应新增事件');
});

// ---------------------------------------------------------------- 备注与非法
test('回退必须备注：没备注返回 NOTE_REQUIRED，状态不变', async () => {
  const { repo, jobId } = await seed();
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'interviewing' });
  const outcome = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'NOTE_REQUIRED');
  assert.equal((await repo.findById(USER, jobId))?.status, 'interviewing', '失败时不得改状态');
});

test('回退带备注成功，事件标记 isRollback', async () => {
  const { repo, jobId } = await seed();
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'interviewing' });
  const outcome = await transitionJobStatus(repo, {
    userId: USER,
    jobId,
    to: 'applied',
    note: '拖错列了，退回已投递',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.kind, 'rollback');
  assert.equal(outcome.event?.isRollback, true);
  assert.equal(outcome.event?.note, '拖错列了，退回已投递');
});

test('终态互转被拒绝（withdrawn → expired）', async () => {
  const { repo, jobId } = await seed();
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'withdrawn', note: '不想去了' });
  const outcome = await transitionJobStatus(repo, { userId: USER, jobId, to: 'expired', note: '试试' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'ILLEGAL_TRANSITION');
  assert.match(outcome.message, /结束状态/);
});

test('终态重新激活：需备注，事件标记 isReactivation', async () => {
  const { repo, jobId } = await seed();
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'withdrawn', note: '不想去了' });
  const noNote = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  assert.equal(noNote.ok, false);
  if (!noNote.ok) assert.equal(noNote.code, 'NOTE_REQUIRED');

  const outcome = await transitionJobStatus(repo, {
    userId: USER,
    jobId,
    to: 'applied',
    note: '企业又联系我了',
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.kind, 'reactivation');
  assert.equal(outcome.event?.isReactivation, true);
});

test('未知目标状态 → ILLEGAL_TRANSITION（不查库）', async () => {
  const { repo, jobId } = await seed();
  const outcome = await transitionJobStatus(repo, { userId: USER, jobId, to: 'offer' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'ILLEGAL_TRANSITION');
  assert.match(outcome.message, /未知状态/);
});

test('并发冲突：from 与库内不一致 → CONFLICT，不写库', async () => {
  const { repo, jobId } = await seed();
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  const outcome = await transitionJobStatus(repo, { userId: USER, jobId, to: 'interviewing', from: 'saved' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'CONFLICT');
  assert.equal(outcome.currentStatus, 'applied');
  assert.equal((await repo.findById(USER, jobId))?.status, 'applied');
});

test('岗位不存在 → NOT_FOUND', async () => {
  const { repo } = await seed();
  const outcome = await transitionJobStatus(repo, { userId: USER, jobId: '00000000-0000-4000-8000-0000000000ff', to: 'applied' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------- 时间线
test('时间线：倒序返回全部事件，limit 生效', async () => {
  const { repo, jobId } = await seed();
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'written_test' });
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'interviewing' });
  await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied', note: '回退看看' });

  const timeline = await listJobTimeline(repo, { userId: USER, jobId });
  assert.ok(timeline);
  assert.equal(timeline!.events.length, 4);
  assert.equal(timeline!.events[0]!.toStatus, 'applied', '最近的事件在最前');
  assert.equal(timeline!.job.status, 'applied');

  const limited = await listJobTimeline(repo, { userId: USER, jobId, limit: 2 });
  assert.equal(limited!.events.length, 2);
});

// ---------------------------------------------------------------- 列表排序（F9）
test('listJobs 排序：deadline 升序、无截止置后；priority 高→低', async () => {
  const repo = createMemoryJobRepository();
  const make = async (company: string, deadline: string | null, priority: '高' | '中' | '低') => {
    const saved = await saveJob(repo, {
      userId: USER,
      extraction: JdExtractionSchema.parse({
        fields: {
          company,
          title: `${company}岗位`,
          cities: ['上海'],
          source: 'manual',
          // 每条 JD 原文必须不同，否则指纹相同会被去重拦截
          raw_text: `${company} 招聘 ${company}岗位，负责${company}业务`,
          deadline:
            deadline === null
              ? ABSENT_DEADLINE
              : { kind: 'provided', at: deadline, text: null },
        },
        // provided 的截止日期必须带原文证据，否则校验阻塞（blocked）
        evidence: deadline === null ? {} : { deadline: `${company} 招聘截止 ${deadline.slice(0, 10)}` },
      }),
    });
    assert.equal(saved.status, 'created', `${company} 应创建成功`);
    // priority 是岗位字段而不是抽取字段，用 update 写入
    return repo.update(USER, saved.job!.id, { priority });
  };

  await make('公司C', null, '中');
  await make('公司A', '2026-11-05T23:59:59+08:00', '低');
  await make('公司B', '2026-11-01T23:59:59+08:00', '高');

  const byDeadline = await listJobs(repo, USER, { sort: 'deadline' });
  assert.deepEqual(
    byDeadline.items.map((job) => job.company),
    ['公司B', '公司A', '公司C'],
    '有截止的按时间升序，无截止排最后',
  );

  const byPriority = await listJobs(repo, USER, { sort: 'priority' });
  assert.deepEqual(
    byPriority.items.map((job) => job.priority).slice(0, 2),
    ['高', '中'],
  );
});
