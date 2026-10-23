#!/usr/bin/env node
/**
 * F-02 验收执行器（JD 入库闭环）
 *
 * 与 F-01 的 `scripts/accept.mjs` 同构：把功能规范里的验收项变成可重复执行的断言，输出可留档报告。
 *
 *   D 系列（数据层）：迁移版本、job_skills 约束、deadline_kind 与三态一致性约束
 *     查询通道**自适应**：优先 `docker compose exec psql`；docker 不可用时回退到
 *     直连 `DATABASE_URL`（pg over TCP）——这样在有库但没 docker CLI 的环境也能验。
 *   L 系列（逻辑层，离线）：规则端到端、技能属性、入库去重、指纹归一化、K=3 一致性
 *   R 系列（可选 --real）：真实模型抽取（消耗 token）
 *
 * 用法：node scripts/verify-f02.mjs [--real] [--report evals/reports/F-02-accept.txt]
 * 退出码：0 全部通过（跳过项不计失败）；1 有失败
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { saveJob } from '../src/lib/jobs/service.ts';
import { extractJd } from '../src/lib/llm/extract.ts';
import { createLLM } from '../src/lib/llm/index.ts';
import { computeConsistency } from '../src/lib/pipeline/consistency.ts';
import { buildFingerprint } from '../src/lib/pipeline/dedupe.ts';
import { validateEnv } from '../src/lib/env.ts';
import { ABSENT_DEADLINE, JdExtractionSchema } from '../src/lib/schemas/jd.ts';

const argv = process.argv.slice(2);
const withRealModel = argv.includes('--real');
const reportIndex = argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;

const reportLines = [];
const baseLog = console.log;
console.log = (...args) => {
  reportLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  baseLog(...args);
};

const USER = '00000000-0000-4000-8000-000000000001';
const MIGRATIONS_DIR = path.resolve('supabase/migrations');
const results = [];
function check(id, name, status, detail) {
  results.push({ id, name, status, detail });
  console.log(`${status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️ ' : '❌'} ${id} ${name}`);
  console.log(`     ${detail}`);
}

const JD = `某科技有限公司 招聘 后端开发工程师（2027届校招）
工作地点：上海 / 杭州
薪资：15k-25k，14薪
学历要求：本科及以上
技能要求：必须精通 Java，熟悉 MySQL；具备 Kubernetes 经验优先
岗位职责：参与后端服务设计与开发，保障系统稳定性与性能，有深度学习相关项目经验者优先
截止时间：2026年11月20日`;

const NOW = new Date('2026-10-23T10:00:00+08:00');

/** 读取 .env（不依赖 dotenv） */
function readEnvFile() {
  const parsed = {};
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index <= 0) continue;
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) parsed[trimmed.slice(0, index).trim()] = value;
    }
  } catch {
    /* 没有 .env 时返回空对象 */
  }
  return parsed;
}

// ---------------------------------------------------------------- 查询通道（docker → 回退 TCP）
const PSQL_ARGS = ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c'];

async function openDatabase() {
  const probe = spawnSync('docker', [...PSQL_ARGS, 'select 1'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) {
    return {
      mode: 'docker compose exec',
      async query(sql) {
        const result = spawnSync('docker', [...PSQL_ARGS, sql], { encoding: 'utf8' });
        if (result.error || result.status !== 0) {
          return { ok: false, error: (result.error?.message ?? result.stderr ?? '').trim().slice(0, 200) };
        }
        return { ok: true, out: (result.stdout || '').trim() };
      },
      async close() {
        /* docker 模式无需清理 */
      },
    };
  }

  const databaseUrl = readEnvFile()['DATABASE_URL'];
  if (!databaseUrl) return null;
  try {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query('select 1');
    return {
      mode: 'pg over TCP（docker 不可用时的回退）',
      async query(sql) {
        try {
          const result = await pool.query(sql);
          const first = result.rows[0];
          const value = first ? Object.values(first)[0] : null;
          return { ok: true, out: value === null || value === undefined ? '' : String(value) };
        } catch (error) {
          return { ok: false, error: String(error.message).slice(0, 200) };
        }
      },
      async close() {
        await pool.end();
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 数据层（D）
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const db = await openDatabase();
if (!db) {
  check('D0', '数据库可达性', 'SKIP', '跳过数据层检查（docker 与 DATABASE_URL 均不可用）—— 先运行 npm run setup');
} else {
  console.log(`（数据层查询方式：${db.mode}）`);

  const applied = await db.query('select string_agg(filename, \',\' order by filename) from schema_migrations');
  const appliedList = applied.ok && applied.out ? applied.out.split(',') : [];
  const missing = migrationFiles.filter((file) => !appliedList.includes(file));
  check(
    'D1',
    `迁移版本（目录 ${migrationFiles.length} 个文件应全部已应用）`,
    applied.ok && missing.length === 0 ? 'PASS' : 'FAIL',
    applied.ok
      ? `已应用 ${appliedList.length} 条${missing.length > 0 ? `，缺失：${missing.join(', ')}` : `（${migrationFiles.join(', ')}）`}`
      : `查询失败：${applied.error}`,
  );

  const skillConstraints = await db.query(
    "select count(*) from pg_constraint where conname in ('job_skills_inferred_proficiency_check','job_skills_basis_phrase_check','job_skills_confidence_check')",
  );
  check(
    'D2',
    'job_skills 约束（反幻觉 / 推测熟练度 / 置信度范围）',
    skillConstraints.out === '3' ? 'PASS' : 'FAIL',
    `命中约束数 = ${skillConstraints.out || skillConstraints.error}（期望 3）`,
  );

  const skillUnique = await db.query(
    "select count(*) from pg_indexes where tablename='job_skills' and indexname='job_skills_job_skill_source_key'",
  );
  check('D2b', 'job_skills 唯一键 (job_id, skill, source)', skillUnique.out === '1' ? 'PASS' : 'FAIL', `index = ${skillUnique.out}`);

  const deadlineKind = await db.query(
    "select count(*) from information_schema.columns where table_name='jobs' and column_name='deadline_kind'",
  );
  check('D3', 'jobs.deadline_kind 列存在（R-3 三态）', deadlineKind.out === '1' ? 'PASS' : 'FAIL', `column = ${deadlineKind.out}`);

  const deadlineText = await db.query(
    "select count(*) from information_schema.columns where table_name='jobs' and column_name='deadline_text'",
  );
  check('D3c', 'jobs.deadline_text 列存在（0004 补漏）', deadlineText.out === '1' ? 'PASS' : 'FAIL', `column = ${deadlineText.out}`);

  const deadlineConstraints = await db.query(
    "select count(*) from pg_constraint where conname in ('jobs_deadline_kind_check','jobs_deadline_consistency_check')",
  );
  check(
    'D3b',
    'jobs 三态与值一致性约束',
    deadlineConstraints.out === '2' ? 'PASS' : 'FAIL',
    `命中约束数 = ${deadlineConstraints.out || deadlineConstraints.error}（期望 2）`,
  );

  await db.close();
}

// ---------------------------------------------------------------- 逻辑层（L）
const extracted = await extractJd({ rawText: JD, now: NOW });
const fields = extracted.extraction.fields;

check(
  'L1',
  '规则模式端到端（无 Key 可入库）',
  extracted.validation.ok && fields.company === '某科技有限公司' && fields.cities.length === 2 ? 'PASS' : 'FAIL',
  `company=${fields.company} cities=${fields.cities.join('/')} deadline=${fields.deadline.kind} blockers=${extracted.validation.blockers.length}`,
);

const mustSkills = fields.skills.filter((s) => s.requirement === 'must').map((s) => s.name);
const skillsOk = fields.skills.length > 0 && fields.skills.every((s) => s.basisPhrase.length > 0);
check(
  'L1b',
  '技能属性（熟练度/必需性/依据）',
  skillsOk && mustSkills.includes('Java') ? 'PASS' : 'FAIL',
  `共 ${fields.skills.length} 个技能，must=${mustSkills.join(',') || '—'}`,
);

const repo = createMemoryJobRepository();
const first = await saveJob(repo, { userId: USER, extraction: extracted.extraction, validation: extracted.validation });
const second = await saveJob(repo, { userId: USER, extraction: extracted.extraction, validation: extracted.validation });
check(
  'L2',
  '入库与去重（created → duplicate）',
  first.status === 'created' && second.status === 'duplicate' ? 'PASS' : 'FAIL',
  `首次=${first.status} 再次=${second.status} 库内条数=${await repo.count(USER)}`,
);

const fingerprintA = buildFingerprint({ company: '某科技有限公司', title: '后端开发工程师（急招）', cities: ['上海', '杭州'] });
const fingerprintB = buildFingerprint({ company: '某科技', title: '后端开发工程师', cities: ['杭州', '上海'] });
check(
  'L3',
  '指纹归一化（后缀/括号/城市顺序）',
  fingerprintA === fingerprintB ? 'PASS' : 'FAIL',
  fingerprintA === fingerprintB ? `同一指纹 ${fingerprintA.slice(0, 12)}…` : '归一化失败：两种写法得到不同指纹',
);

const sample = (company) =>
  JdExtractionSchema.parse({
    fields: { company, title: '后端开发工程师', cities: ['上海'], source: 'manual', raw_text: 'x', deadline: ABSENT_DEADLINE },
  });
const consistent = computeConsistency([sample('某科技'), sample('某科技'), sample('字节跳动')]);
check(
  'L4',
  'K=3 自一致性（2/3 → 0.667 → 待确认）',
  consistent.agreement.company === 0.667 && consistent.extraction.fields.company === '某科技' ? 'PASS' : 'FAIL',
  `company 一致率=${consistent.agreement.company} 众数=${consistent.extraction.fields.company} 整体=${consistent.score}`,
);

// ---------------------------------------------------------------- 真实模型（R，可选）
if (withRealModel) {
  const loaded = validateEnv(readEnvFile());
  const service = loaded.ok && loaded.env ? createLLM(loaded.env, { skipProbe: true }) : null;
  if (!service?.hasCredential) {
    check('R1', '真实模型抽取（--real）', 'SKIP', '未配置 LLM_API_KEY，跳过（规则模式已由 L1 覆盖）');
  } else {
    const live = await extractJd({ rawText: JD, now: NOW }, { service, sampleK: 1 });
    check(
      'R1',
      '真实模型抽取（L0 tool calling）',
      live.level === 'L0' && live.extraction.fields.company.length > 0 ? 'PASS' : 'FAIL',
      `level=${live.level} path=${live.path} company=${live.extraction.fields.company} skills=${live.extraction.fields.skills.length}`,
    );
  }
} else {
  check('R1', '真实模型抽取', 'SKIP', '未加 --real，跳过（不消耗 token）');
}

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => r.status === 'FAIL');
const passed = results.filter((r) => r.status === 'PASS');
const skipped = results.filter((r) => r.status === 'SKIP');
console.log('\n══════════════════════════════════════════════════════════════════════');
console.log(`合计 ${results.length} 项：✅ ${passed.length} · ❌ ${failed.length} · ⏭️ ${skipped.length}`);
if (failed.length === 0) {
  console.log('✅ F-02 可验部分全部通过');
  if (skipped.length > 0) console.log(`⏭️  跳过项：${skipped.map((r) => r.id).join(', ')}（按提示补齐环境后可复验）`);
} else {
  console.log(`❌ 失败项：${failed.map((r) => r.id).join(', ')}`);
}
console.log('══════════════════════════════════════════════════════════════════════');

if (reportPath) {
  const absolute = path.resolve(reportPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${reportLines.join(os.EOL)}${os.EOL}`, 'utf8');
  baseLog(`\n📄 报告已写入：${absolute}（UTF-8）`);
}

process.exit(failed.length === 0 ? 0 : 1);
