/**
 * F-08 验收器（I3 T9）
 *
 * 三层检查，全部可自动判定：
 *   ① 状态机规则：169 组合穷举（允许 157 / 拒绝 12）
 *   ② 数据库结构：job_events 表、3 个约束、索引、迁移计数
 *   ③ 真实链路：创建 → 前进 → 回退（备注）→ 终态 → 重新激活 → 时间线，跑完自清理
 *
 * 用法：
 *   node scripts/verify-f08.mjs            # 逐项输出
 *   node scripts/verify-f08.mjs --report   # 额外写入 evals/reports/F-08-accept.txt
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { createPostgresJobRepository } from '../src/lib/db/postgres.ts';
import { listJobTimeline, transitionJobStatus } from '../src/lib/jobs/status-service.ts';
import { saveJob } from '../src/lib/jobs/service.ts';
import { ABSENT_DEADLINE, JdExtractionSchema } from '../src/lib/schemas/jd.ts';
import { JOB_STATUSES, TERMINAL_STATUSES, decideTransition } from '../src/lib/status.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const lines = [];
const checks = [];

function check(name, pass, detail = '') {
  checks.push({ name, pass });
  const line = `${pass ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line);
  lines.push(line);
}

// ---------------------------------------------------------------- ① 状态机
let allowed = 0;
let rejected = 0;
const rejectedPairs = [];
for (const from of JOB_STATUSES) {
  for (const to of JOB_STATUSES) {
    const decision = decideTransition(from, to);
    if (decision.allowed) allowed += 1;
    else {
      rejected += 1;
      rejectedPairs.push(`${from}→${to}`);
    }
  }
}
const expectedRejected = TERMINAL_STATUSES.flatMap((from) =>
  TERMINAL_STATUSES.filter((to) => to !== from).map((to) => `${from}→${to}`),
);
check('13×13 穷举：允许 157 / 拒绝 12', allowed === 157 && rejected === 12, `实际 ${allowed}/${rejected}`);
check(
  '拒绝集合 = 终态互转（不含同状态）',
  rejectedPairs.sort().join(',') === expectedRejected.slice().sort().join(','),
  `示例 ${rejectedPairs[0] ?? '-'}`,
);

// ---------------------------------------------------------------- ② 数据库结构
const env = {};
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const index = trimmed.indexOf('=');
  if (index <= 0) continue;
  let value = trimmed.slice(index + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (value) env[trimmed.slice(0, index).trim()] = value;
}

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: env.DATABASE_URL });

try {
  const tables = await pool.query(
    "select 1 from information_schema.tables where table_schema='public' and table_name='job_events'",
  );
  check('job_events 表存在', tables.rowCount === 1);

  const constraints = await pool.query(
    "select conname from pg_constraint where conname in ('jobs_status_check','job_events_from_status_check','job_events_to_status_check')",
  );
  check('状态 CHECK 约束齐全（3 个）', constraints.rowCount === 3, `${constraints.rowCount}/3`);

  const index = await pool.query(
    "select 1 from pg_indexes where tablename='job_events' and indexname='job_events_job_idx'",
  );
  check('时间线索引存在', index.rowCount === 1);

  const migrations = await pool.query('select count(*)::int as n from schema_migrations');
  check('迁移计数 = 6', migrations.rows[0].n === 6, `实际 ${migrations.rows[0].n}`);
} catch (error) {
  check('数据库可连接', false, error instanceof Error ? error.message : String(error));
} finally {
  // 连接保持到链路验证结束
}

// ---------------------------------------------------------------- ③ 真实链路
try {
  const repo = await createPostgresJobRepository(env.DATABASE_URL);
  const MARK = `__F08_ACCEPT__${Date.now()}`;
  const seeded = await saveJob(repo, {
    userId: USER,
    extraction: JdExtractionSchema.parse({
      fields: {
        company: MARK,
        title: 'F-08 验收岗',
        cities: ['上海'],
        source: 'manual',
        raw_text: `${MARK} 验收链路`,
        deadline: ABSENT_DEADLINE,
      },
    }),
  });
  const jobId = seeded.job.id;

  const forward = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
  check('前进 saved→applied', forward.ok);
  const rollbackNoNote = await transitionJobStatus(repo, { userId: USER, jobId, to: 'saved' });
  check('回退无备注被拒', !rollbackNoNote.ok && rollbackNoNote.code === 'NOTE_REQUIRED');
  const rollback = await transitionJobStatus(repo, { userId: USER, jobId, to: 'saved', note: '验收：回退' });
  check('回退带备注并标记 isRollback', rollback.ok && rollback.event.isRollback === true);
  const terminal = await transitionJobStatus(repo, { userId: USER, jobId, to: 'withdrawn', note: '验收：结束' });
  check('进入终态', terminal.ok);
  const reactivate = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied', note: '验收：重新激活' });
  check('重新激活并标记 isReactivation', reactivate.ok && reactivate.event.isReactivation === true);
  const conflict = await transitionJobStatus(repo, { userId: USER, jobId, to: 'interviewing', from: 'saved' });
  check('并发冲突 CONFLICT', !conflict.ok && conflict.code === 'CONFLICT');

  const timeline = await listJobTimeline(repo, { userId: USER, jobId, limit: 100 });
  // 成功流转 4 次：前进 → 回退 → 进终态 → 重新激活（"回退无备注"被拒，不写事件）
  check('时间线倒序完整（4 条）', timeline !== null && timeline.events.length === 4, `${timeline?.events.length ?? 0} 条`);

  const events = await pool.query('delete from job_events where job_id = $1', [jobId]);
  await pool.query('delete from jobs where id = $1', [jobId]);
  lines.push(`（清理：events ${events.rowCount} 条、job 1 条）`);
} catch (error) {
  check('真实链路验证', false, error instanceof Error ? error.message : String(error));
} finally {
  await pool.end();
}

// ---------------------------------------------------------------- 汇总
const passed = checks.filter((item) => item.pass).length;
const summary = `\n结果：${passed}/${checks.length} 项通过 ${passed === checks.length ? '✅ 通过' : '❌ 未通过'}`;
console.log(summary);
lines.push(summary);

if (process.argv.includes('--report')) {
  mkdirSync('evals/reports', { recursive: true });
  const report = [
    '# F-08 投递状态机与看板 · 自动验收报告',
    `生成时间：${new Date().toISOString()}`,
    '',
    '```',
    ...lines,
    '```',
    '',
    '## 未自动覆盖、需人工走查的项',
    '',
    '- [ ] `/jobs/board` 拖拽手感与 9 列排版（1080p）',
    '- [ ] 键盘 ←/→ 流转可访问性',
    '- [ ] 备注弹窗的打断体验',
    '- [ ] `/jobs/[id]` 时间线与「提交流转」表单',
    '- [ ] 重复 JD「合并到已有」后字段补齐与原文追加',
    '',
  ].join('\n');
  writeFileSync('evals/reports/F-08-accept.txt', report, 'utf8');
  console.log('报告已写入 evals/reports/F-08-accept.txt');
}

process.exit(passed === checks.length ? 0 : 1);
