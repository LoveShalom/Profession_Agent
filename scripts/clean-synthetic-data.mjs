/**
 * 清理"合成/错误"数据（一次性维护脚本）
 *
 * 背景：开发期有几批脚本造的数据与"早期切分 bug"留下的脏经历：
 *   · 经历 org 是**人名**（简历头部被误切成经历）→ 邓一凡 ×N
 *   · 经历 org 是**日期字符串**（日期行被误切成 org）→ "2024.6 -- 2026.6"
 *   · 开发期造的假公司（XX 公司 / 某科技有限公司 / 示例科技 / __F08_DEMO__ / __*_SELFTEST__ / CHECK测试）
 *
 * 安全原则：
 *   · 默认 **dry-run**，只打印不修改；
 *   · `--apply` 才执行，且**软删除**（deleted_at），可在「显示已删除」里恢复；
 *   · 只匹配明确特征，不动真实岗位/经历；
 *   · 同时清理 `data/tmp` 下我造的样本文件（会列出来，删前确认路径在本仓库内）。
 *
 * 用法：
 *   node scripts/clean-synthetic-data.mjs            # 只报告
 *   node scripts/clean-synthetic-data.mjs --apply    # 执行（软删除）
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const USER = '00000000-0000-4000-8000-000000000001';

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

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// ---------------------------------------------------------------- 匹配规则
/** 假公司：开发期脚本造的数据 */
const FAKE_COMPANY = [
  /^__[A-Z0-9_]+__/, // __F08_DEMO__ / __STATUS_SELFTEST__ / __DATE_SELFTEST__ / __IMPORT_SELFTEST__
  /XX\s*公司/i,
  /某科技有限公司/,
  /^示例/, // 示例科技/示例数据…
  /CHECK测试/,
  /^测试/,
];

/** 脏经历：org 是人名或日期 */
const BAD_ORG = [
  /^[\u4e00-\u9fa5]{2,3}$/, // 2~3 个汉字，且不是机构名（下面再排除常见机构后缀）
  /^\d{4}\s*[.\-/年]\s*\d{1,2}/, // 2024.6 -- 2026.6 / 2026.1 - 2026.5
  /^\d{4}\s*[-~至到]\s*\d{4}/,
];

const ORG_SUFFIX = /(公司|集团|科技|银行|证券|基金|大学|学院|研究院|研究所|实验室|中心|医院|事业部|工作室|团队|委员会|机构|学校)/;

/** 脏经历：org 是人名、日期，或开发期造的假机构 */
const FAKE_ORG = [/^XX\s*公司$/i, /某科技有限公司/, /^示例/, /CHECK测试/, /^测试/];

function isBadOrg(org) {
  const value = (org ?? '').trim();
  if (value.length === 0) return { bad: true, reason: 'org 为空' };
  if (FAKE_ORG.some((pattern) => pattern.test(value))) return { bad: true, reason: `开发期假数据：${value}` };
  if (ORG_SUFFIX.test(value)) return { bad: false };
  for (const pattern of BAD_ORG) {
    if (pattern.test(value)) return { bad: true, reason: `org 疑似人名/日期：${value}` };
  }
  return { bad: false };
}

// ---------------------------------------------------------------- 扫描岗位
const jobs = await pool.query('select id, company, title, deleted_at from jobs where user_id = $1', [USER]);
const badJobs = jobs.rows.filter((row) => FAKE_COMPANY.some((pattern) => pattern.test(String(row.company ?? ''))));

console.log(`\n=== 岗位：共 ${jobs.rows.length} 条，命中合成特征 ${badJobs.length} 条 ===`);
for (const row of badJobs) console.log(`  - ${row.company} / ${row.title}（${row.deleted_at ? '已软删' : '未删除'}）`);
if (badJobs.length === 0) console.log('  未发现合成岗位（你现有的岗位都是真实的）');

// ---------------------------------------------------------------- 扫描经历
const exps = await pool.query('select id, org, role, star_action, deleted_at from experiences where user_id = $1', [USER]);
const badExps = [];
for (const row of exps.rows) {
  const verdict = isBadOrg(String(row.org ?? ''));
  if (verdict.bad) badExps.push({ ...row, reason: verdict.reason });
}

console.log(`\n=== 经历：共 ${exps.rows.length} 条，命中脏数据 ${badExps.length} 条 ===`);
for (const row of badExps) {
  const action = String(row.star_action ?? '').slice(0, 40);
  console.log(`  - org="${row.org}" role="${row.role ?? ''}"（${row.reason}）`);
  console.log(`    行动摘要：${action || '（空）'}`);
}

// ---------------------------------------------------------------- 本地合成文件
const tmpFiles = existsSync('data/tmp')
  ? readdirSync('data/tmp').map((name) => {
      const full = path.join('data/tmp', name);
      return { full, size: statSync(full).size };
    })
  : [];
console.log(`\n=== data/tmp 下我造的样本文件：${tmpFiles.length} 个 ===`);
for (const file of tmpFiles) console.log(`  - ${file.full}（${file.size} 字节）`);

// ---------------------------------------------------------------- 执行
if (!APPLY) {
  console.log('\n（dry-run）没有任何修改。确认无误后运行：node scripts/clean-synthetic-data.mjs --apply');
  await pool.end();
  process.exit(0);
}

let softDeletedJobs = 0;
let softDeletedExps = 0;
for (const row of badJobs) {
  if (row.deleted_at) continue;
  await pool.query('update jobs set deleted_at = now(), updated_at = now() where id = $1', [row.id]);
  softDeletedJobs += 1;
}
for (const row of badExps) {
  if (row.deleted_at) continue;
  await pool.query('update experiences set deleted_at = now(), updated_at = now() where id = $1', [row.id]);
  softDeletedExps += 1;
}

let removedFiles = 0;
for (const file of tmpFiles) {
  const resolved = path.resolve(file.full);
  const allowed = resolved.startsWith(path.resolve('data/tmp') + path.sep);
  if (!allowed) continue;
  rmSync(resolved, { force: true });
  removedFiles += 1;
}

console.log('\n=== 已执行 ===');
console.log(`  软删除岗位：${softDeletedJobs} 条（可在 /jobs 的"显示已删除"里恢复）`);
console.log(`  软删除经历：${softDeletedExps} 条（可在 /experiences 的"显示已删除"里恢复）`);
console.log(`  删除 samples：${removedFiles} 个文件`);
console.log('\n说明：评测集 evals/jd/dataset.jsonl 与 Demo 样例 evals/demo/sample.json 是仓库资产（不是你的数据），予以保留。');

await pool.end();
