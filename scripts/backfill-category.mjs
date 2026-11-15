/**
 * 迁移 0009 + 回填岗位分类（F-02 修订）
 *
 * 用法：
 *   node scripts/backfill-category.mjs            # 应用迁移 + 按规则回填已有岗位
 *   node scripts/backfill-category.mjs --dry-run  # 只看会改成什么
 *   node scripts/backfill-category.mjs --force    # 连用户已手改的分类也覆盖（默认不动手改过的）
 */

import { readFileSync } from 'node:fs';

import { deriveJobCategory } from '../src/lib/jobs/category.ts';

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
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

// ① 应用迁移 0009（幂等）
if (!DRY) {
  const sql = readFileSync('supabase/migrations/0009_jobs_category.sql', 'utf8');
  await pool.query(sql);
  await pool.query("insert into schema_migrations (filename) values ('0009_jobs_category.sql') on conflict (filename) do nothing");
  console.log('✅ 迁移 0009 已应用');
}

// ② 回填分类
const { rows } = await pool.query(
  "select id, company, title, skills, raw_text, category from jobs where user_id = $1 order by created_at",
  [USER],
);
console.log(`\n共 ${rows.length} 个岗位：`);

let updated = 0;
for (const row of rows) {
  const match = deriveJobCategory({ title: row.title, skills: row.skills ?? [], rawText: row.raw_text });
  const current = row.category;
  const alreadyManual = current !== null && current !== match.code && !FORCE;
  const next = alreadyManual ? current : match.code;
  const action = current === next ? '不变' : alreadyManual ? '保留手改' : '回填';
  console.log(`  ${row.company} / ${row.title}`);
  console.log(`    分类：${current ?? '（空）'} → ${next}（${match.label}，${match.reason}）[${action}]`);
  if (!DRY && current !== next) {
    await pool.query('update jobs set category = $1, updated_at = now() where id = $2', [next, row.id]);
    updated += 1;
  }
}

console.log(`\n${DRY ? '（dry-run）' : ''}回填 ${updated} 个岗位`);
console.log('说明：分类是"规则推荐 + 用户可改"，你可以在 /jobs/[id] 的「岗位分类」卡片里手动调整。');
await pool.end();
