import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 迁移脚本的静态护栏（防"精简 Postgres 栈上迁移中止"复发）
 *
 * 背景（2026-10-21 首次验收实况）：
 *   ADR-0001 默认用纯 pgvector/Postgres 精简栈，但 0001_init.sql 末尾直接写了
 *   `create policy ... to authenticated using (auth.uid() = ...)`。
 *   纯 Postgres 既没有 authenticated 角色、也没有 auth.uid() 函数 → 0001 在 RLS 段报错中止
 *   → 0002 从未执行；容器因 restart 策略重启后变 healthy，表面上"一切正常"。
 *
 * 结论：Supabase 专有语法必须包在按环境守卫的 DO 块里。本测试把这条约束固化下来，
 * 避免下次再靠"连上数据库才发现"。
 */

const MIGRATIONS_DIR = path.resolve('supabase/migrations');
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/** 环境守卫标记：只有 Supabase 才有的 auth schema */
const GUARD_MARKER = "pg_namespace where nspname = 'auth'";

/**
 * 剥离 SQL 行注释后再做语法检查。
 * 必要性：说明性注释里会提到 `auth.uid()` / `to authenticated`（正是本 bug 的解释），
 * 若不剥离会被误判为真实代码。这也是上一版测试自身踩的坑。
 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

test('迁移文件存在且以数字前缀排序', () => {
  assert.ok(files.length >= 2, `迁移文件过少：${files.join(', ')}`);
  for (const file of files) {
    assert.match(file, /^\d{4}_[a-z0-9_]+\.sql$/, `文件名应符合 NNNN_name.sql：${file}`);
  }
  assert.deepEqual(files, [...files].sort(), '文件应按字典序排列（执行顺序依赖它）');
});

for (const file of files) {
  const raw = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const sql = stripSqlComments(raw);

  test(`${file}：Supabase 专有标识符只能出现在环境守卫之后`, () => {
    const guardIndex = sql.indexOf(GUARD_MARKER);
    for (const token of ['to authenticated', 'auth.uid()']) {
      const index = sql.indexOf(token);
      if (index === -1) continue;
      assert.notEqual(
        guardIndex,
        -1,
        `${file} 使用了「${token}」但没有环境守卫（精简 Postgres 栈会整体中止）`,
      );
      assert.ok(
        guardIndex < index,
        `${file}：守卫标记出现在「${token}」之后，顺序错误`,
      );
    }
  });

  test(`${file}：create policy 必须用 execute 动态执行（纯 Postgres 不解析）`, () => {
    const lines = sql.split('\n');
    lines.forEach((line, i) => {
      const bare = /^\s*create\s+(or\s+replace\s+)?policy\b/i.test(line);
      assert.equal(bare, false, `${file}:${i + 1} 存在裸 create policy，必须写成 execute $p$create policy ...$p$`);
    });
  });

  test(`${file}：具备幂等标记（可重复执行）`, () => {
    // 迁移有两类：建表型（create table if not exists）与补列型（alter table ... add column if not exists）。
    // 断言"存在至少一种幂等构造"，而不是要求每份迁移都建表——0004 只补了一列。
    const idempotentMarkers = [
      /create\s+table\s+if\s+not\s+exists/i,
      /alter\s+table\s+[\w."]+\s+add\s+column\s+if\s+not\s+exists/i,
      /drop\s+\w+\s+if\s+exists/i,
      /on\s+conflict\s+do\s+nothing/i,
      /create\s+(?:unique\s+)?index\s+if\s+not\s+exists/i,
      /create\s+or\s+replace\s+(?:view|function)/i,
    ];
    const matched = idempotentMarkers.filter((pattern) => pattern.test(sql));
    assert.ok(matched.length > 0, `${file} 看不出幂等意图（需包含 if not exists / on conflict / create or replace）`);
  });

  test(`${file}：不得出现破坏性语句（红线②：验收不得破坏数据）`, () => {
    const destructive = [/\bdrop\s+table\b/i, /\btruncate\b/i, /\bdelete\s+from\s+\w+\s*;/i];
    for (const pattern of destructive) {
      assert.equal(pattern.test(sql), false, `${file} 含破坏性语句：${pattern}`);
    }
  });
}

test('0001：建齐 I0/I1 需要的核心表与单用户播种', () => {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
  for (const table of ['users', 'jobs', 'experiences']) {
    assert.match(sql, new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}\\b`, 'i'), `缺少表 ${table}`);
  }
  assert.match(sql, /00000000-0000-4000-8000-000000000001/, '缺少单用户播种 ID（与 tenant.ts 的 SINGLE_USER_ID 对齐）');
  assert.match(sql, /on\s+conflict\s*\(id\)\s*do\s+nothing/i, '单用户播种必须幂等');
  // G-06：指纹唯一索引必须带 user_id
  assert.match(sql, /unique\s+index[^;]*jobs\s*\(\s*user_id\s*,\s*fingerprint\s*\)/i, '指纹唯一索引必须为 (user_id, fingerprint)');
});

test('0002：建齐凭证与用量表，且提供脱敏视图', () => {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, '0002_credentials_usage.sql'), 'utf8');
  assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+user_llm_credentials\b/i);
  assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+llm_usage_logs\b/i);
  assert.match(sql, /encrypted_api_key\s+bytea/i, '密钥必须以密文（bytea）存储');
  assert.match(sql, /create\s+or\s+replace\s+view\s+llm_credentials_summary/i, '缺少脱敏视图');
  assert.match(sql, /degraded\s+boolean/i, 'llm_usage_logs 需要 degraded 标记（降级率统计依赖它）');
  // 凭证表启用 RLS 但不建策略 = 默认全拒绝（安全默认）
  assert.match(sql, /alter\s+table\s+user_llm_credentials\s+enable\s+row\s+level\s+security/i);
});
