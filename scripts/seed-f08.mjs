/**
 * F-08 验收演示数据（I3）
 *
 * 用途：看板/详情页验收需要"每个状态都有卡"，手动造数据太麻烦。
 *   node scripts/seed-f08.mjs           # 创建演示岗位（覆盖多个状态）
 *   node scripts/seed-f08.mjs --clean   # 删除全部演示岗位（含事件）
 *
 * 特点：所有演示岗位公司名带 `__F08_DEMO__` 前缀，便于识别与清理，不碰真实数据。
 */

import { readFileSync } from 'node:fs';

import { createPostgresJobRepository } from '../src/lib/db/postgres.ts';
import { transitionJobStatus } from '../src/lib/jobs/status-service.ts';
import { saveJob } from '../src/lib/jobs/service.ts';
import { JdExtractionSchema } from '../src/lib/schemas/jd.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const MARK = '__F08_DEMO__';
const clean = process.argv.includes('--clean');

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

if (clean) {
  const events = await pool.query(
    'delete from job_events where job_id in (select id from jobs where user_id = $1 and company like $2)',
    [USER, `${MARK}%`],
  );
  const jobs = await pool.query('delete from jobs where user_id = $1 and company like $2', [USER, `${MARK}%`]);
  console.log(`已清理演示数据：events ${events.rowCount} 条、jobs ${jobs.rowCount} 条`);
  await pool.end();
  process.exit(0);
}

const repo = await createPostgresJobRepository(env.DATABASE_URL);

/** 停到指定状态的流转路径 */
const PATH = {
  saved: [],
  to_apply: ['to_apply'],
  applied: ['to_apply', 'applied'],
  interviewing: ['to_apply', 'applied', 'interviewing'],
  offered: ['to_apply', 'applied', 'interviewing', 'offer_pending', 'offered'],
  withdrawn: ['to_apply', 'applied', 'withdrawn'],
};

const specs = [
  { company: `${MARK}星辰科技`, title: '后端开发工程师（Java）', city: '上海', deadline: '2026-11-16T23:59:59+08:00', path: 'to_apply', priority: '高' },
  { company: `${MARK}云图数据`, title: '数据平台工程师', city: '杭州', deadline: '2026-11-13T23:59:59+08:00', path: 'applied', priority: '高' },
  { company: `${MARK}灵犀智能`, title: '算法工程师（NLP）', city: '深圳', deadline: null, path: 'interviewing', priority: '中' },
  { company: `${MARK}海风网络`, title: '前端工程师', city: '广州', deadline: '2026-11-25T23:59:59+08:00', path: 'offered', priority: '中' },
  { company: `${MARK}极光安全`, title: '安全研发', city: '北京', deadline: null, path: 'withdrawn', priority: '低' },
  { company: `${MARK}青禾医疗`, title: '数据工程师', city: '成都', deadline: null, path: 'saved', priority: '低' },
];

for (const spec of specs) {
  const deadline = spec.deadline
    ? { kind: 'provided', at: spec.deadline, text: null }
    : { kind: 'absent', at: null, text: null };
  const evidence = spec.deadline ? { deadline: `截止 ${spec.deadline.slice(0, 10)}` } : {};

  const saved = await saveJob(repo, {
    userId: USER,
    extraction: JdExtractionSchema.parse({
      fields: {
        company: spec.company,
        title: spec.title,
        cities: [spec.city],
        source: 'manual',
        raw_text: `${spec.company} 招聘 ${spec.title}（${spec.city}）。${MARK} 演示数据，可安全删除。`,
        deadline,
      },
      evidence,
    }),
  });
  if (!saved.job) {
    console.log(`✖ ${spec.company} 创建失败：${saved.status} ${saved.messages.join('；')}`);
    continue;
  }

  if (spec.priority !== '中') {
    await repo.update(USER, saved.job.id, { priority: spec.priority });
  }

  const steps = PATH[spec.path] ?? [];
  for (const to of steps) {
    const outcome = await transitionJobStatus(repo, {
      userId: USER,
      jobId: saved.job.id,
      to,
      note: to === 'withdrawn' ? '演示：本人放弃' : undefined,
    });
    if (!outcome.ok) {
      console.log(`⚠ ${spec.company} 流转到 ${to} 失败：${outcome.message}`);
    }
  }
  console.log(`✔ ${spec.company}（${spec.title}）→ ${spec.path}`);
}

await pool.end();
console.log(`\n演示数据已创建（公司名以 ${MARK} 开头）。验收后可运行：node scripts/seed-f08.mjs --clean`);
