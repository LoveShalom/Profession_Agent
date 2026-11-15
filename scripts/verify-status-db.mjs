/**
 * 真实库验证：状态流转 + 事件事务（F-08 T3/T4）
 * 用法：node scripts/verify-status-db.mjs
 */
import { readFileSync } from 'node:fs';

import { createPostgresJobRepository } from '../src/lib/db/postgres.ts';
import { listJobTimeline, transitionJobStatus } from '../src/lib/jobs/status-service.ts';
import { saveJob } from '../src/lib/jobs/service.ts';
import { ABSENT_DEADLINE, JdExtractionSchema } from '../src/lib/schemas/jd.ts';

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

const USER = '00000000-0000-4000-8000-000000000001';
const MARK = `__STATUS_SELFTEST__${Date.now()}`;
const repo = await createPostgresJobRepository(env.DATABASE_URL);

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

const seeded = await saveJob(repo, {
  userId: USER,
  extraction: JdExtractionSchema.parse({
    fields: {
      company: MARK,
      title: '状态机验证岗',
      cities: ['上海'],
      source: 'manual',
      raw_text: `${MARK} 状态机验证，测试事务与事件`,
      deadline: ABSENT_DEADLINE,
    },
  }),
});
const jobId = seeded.job.id;

const step1 = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
check('saved → applied', step1.ok && (await repo.findById(USER, jobId)).status === 'applied');

const step2 = await transitionJobStatus(repo, { userId: USER, jobId, to: 'interviewing' });
check('applied → interviewing（跨步）', step2.ok && (await repo.findById(USER, jobId)).status === 'interviewing');

const step3 = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied' });
check('回退无备注 → NOTE_REQUIRED', !step3.ok && step3.code === 'NOTE_REQUIRED');

const step4 = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied', note: '拖错列了' });
check('回退带备注 → isRollback 落库', step4.ok && step4.event.isRollback === true && step4.event.note === '拖错列了');

const step5 = await transitionJobStatus(repo, { userId: USER, jobId, to: 'rejected_by_company', note: '三面挂' });
check('进入终态 → 事件记录', step5.ok && step5.event.toStatus === 'rejected_by_company');

const step6 = await transitionJobStatus(repo, { userId: USER, jobId, to: 'expired', note: '试试' });
check('终态互转 → ILLEGAL_TRANSITION', !step6.ok && step6.code === 'ILLEGAL_TRANSITION');

const step7 = await transitionJobStatus(repo, { userId: USER, jobId, to: 'applied', note: '企业又联系我了' });
check('重新激活 → isReactivation 落库', step7.ok && step7.event.isReactivation === true);

const step8 = await transitionJobStatus(repo, { userId: USER, jobId, to: 'interviewing', from: 'saved' });
check('并发 from 不一致 → CONFLICT', !step8.ok && step8.code === 'CONFLICT');

const timeline = await listJobTimeline(repo, { userId: USER, jobId });
check('时间线倒序 + 5 条', timeline !== null && timeline.events.length === 5 && timeline.events[0].toStatus === 'applied',
  `${timeline?.events.length ?? 0} 条`);

const { Pool } = await import('pg');
const pool = new Pool({ connectionString: env.DATABASE_URL });
const events = await pool.query('delete from job_events where job_id = $1', [jobId]);
const jobs = await pool.query('delete from jobs where id = $1', [jobId]);
await pool.end();
console.log(`\n清理：events ${events.rowCount} 条、jobs ${jobs.rowCount} 条`);
console.log(`结果：${checks.filter((item) => item.pass).length}/${checks.length} 项通过`);
process.exit(checks.every((item) => item.pass) ? 0 : 1);
