#!/usr/bin/env node
/**
 * AC-2 幂等验收（脚本版）
 *
 * 为什么需要脚本：指南 §2.3 的手工流程最后一步是"删除测试行"，于是验收结束时
 * `select count(*) ... = 0` 既可能是"验完清理了"，也可能是"根本没插进去"——无法区分。
 * 更糟的是：跑第二次就无法复现第一次的结论。本脚本把全过程收敛成一条命令，
 * 自动记录基线、执行两次 setup、逐项比对，并**在清理前**给出结论与证据。
 *
 * 检查项（对应 F-01 的 AC-2）：
 *   1. setup 连续执行两次均成功（退出码 0）
 *   2. 已有数据不丢：测试行仍在、jobs 总行数不变（除测试行）、users 行数不变
 *   3. `.env` 已有键值不被覆盖：逐键比对，只允许"新增缺失项"
 *   4. 迁移不重复：schema_migrations 行数不变
 *
 * 用法：
 *   node scripts/verify-idempotency.mjs [--report evals/reports/F-01-idempotency.txt] [--keep]
 *   --keep  保留测试行（默认会清理）
 * 退出码：0 全部通过；1 有失败项；2 环境不可用（Docker/数据库）
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const reportIndex = argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;
const keepTestRow = argv.includes('--keep');

// 报告留档：tee console.log，最后以 UTF-8 落盘（不要用 PowerShell 的 `*>`，PS5.1 会双重乱码）
const reportLines = [];
const baseLog = console.log;
console.log = (...logArgs) => {
  reportLines.push(logArgs.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  baseLog(...logArgs);
};

const PSQL_ARGS = ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c'];

/** 执行一条 psql 查询，返回去掉首尾空白的标量文本 */
function psql(sql) {
  const result = spawnSync('docker', [...PSQL_ARGS, sql], { encoding: 'utf8' });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || '').trim() || `psql 退出码 ${result.status}` };
  return { ok: true, out: (result.stdout || '').trim() };
}

function scalar(sql) {
  const result = psql(sql);
  if (!result.ok) throw new Error(`查询失败：${sql}\n${result.error}`);
  return result.out;
}

/** 解析 .env 为键值表（忽略注释与空行） */
function parseEnv(text) {
  const map = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value !== '') map.set(key, value);
  }
  return map;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const checks = [];
function check(id, name, ok, detail) {
  checks.push({ id, name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${id} ${name}`);
  console.log(`     ${detail}`);
}

function runSetup(label) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['scripts/setup.mjs'], { encoding: 'utf8' });
  const elapsedMs = Date.now() - startedAt;
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = !result.error && result.status === 0;
  // 只打印关键行，完整输出进报告
  const keyLines = text
    .split(/\r?\n/)
    .filter((line) => /^(✅|⚠️|❌|▶|📄)/.test(line.trim()))
    .join('\n');
  console.log(`   ${label}：退出码=${result.status} 耗时=${(elapsedMs / 1000).toFixed(1)}s`);
  if (keyLines) console.log(keyLines.split('\n').map((l) => `   │ ${l}`).join('\n'));
  if (!ok && text) console.log(`   │（失败详情见报告文件）`);
  reportLines.push(`\n----- ${label} 完整输出（退出码=${result.status}）-----`, text);
  return { ok, elapsedMs, text };
}

console.log('┌──────────────────────────────────────────────────────────────────────┐');
console.log('│  AC-2 幂等验收（setup 连跑两次，验证数据不丢、配置不被覆盖）          │');
console.log('└──────────────────────────────────────────────────────────────────────┘\n');

// ---------- 0. 环境预检 ----------
const ping = psql('select 1');
if (!ping.ok) {
  console.log('❌ 无法访问数据库，本脚本需要运行中的 db 容器。');
  console.log(`   原因：${ping.error}`);
  console.log('\n处理：');
  console.log('   1) 启动本地栈：npm run setup');
  console.log('   2) 确认容器状态：docker compose ps（应为 healthy）');
  console.log('   3) 若在受限沙箱中运行：沙箱不允许访问 Docker 命名管道，请在普通终端执行');
  process.exit(2);
}

const envFile = path.resolve('.env');
if (!existsSync(envFile)) {
  console.log('❌ 未找到 .env，先运行 npm run setup');
  process.exit(2);
}

// ---------- 1. 基线 ----------
const envBefore = readFileSync(envFile, 'utf8');
const envMapBefore = parseEnv(envBefore);
const jobsBefore = Number(scalar('select count(*) from jobs'));
const usersBefore = Number(scalar('select count(*) from users'));
const migrationsBefore = Number(scalar('select count(*) from schema_migrations'));
const fingerprint = `fp-idem-${Date.now()}`;

console.log('【基线】');
console.log(`   .env 哈希   = ${sha256(envBefore).slice(0, 16)}…`);
console.log(`   jobs 行数   = ${jobsBefore}`);
console.log(`   users 行数  = ${usersBefore}`);
console.log(`   migrations = ${migrationsBefore}`);
console.log(`   测试指纹    = ${fingerprint}\n`);

// ---------- 2. 插入测试数据 ----------
const insert = psql(
  `insert into jobs (user_id, company, title, raw_text, fingerprint) values ` +
    `('00000000-0000-4000-8000-000000000001','幂等测试公司','测试岗','raw text','${fingerprint}') on conflict do nothing;`,
);
if (!insert.ok) {
  console.log(`❌ 测试数据插入失败：${insert.error}`);
  process.exit(1);
}
check('准备', '插入测试数据', Number(scalar(`select count(*) from jobs where fingerprint='${fingerprint}'`)) === 1, `已插入 1 行（指纹 ${fingerprint}）`);
console.log('');

// ---------- 3. 连跑两次 setup ----------
console.log('【执行】连续运行两次 npm run setup');
let run1 = null;
let run2 = null;
// ⚠️ 断言必须在 finally 清理之前执行，否则会把"测试行仍在"这个证据自己删掉
// （2026-10-21 首版就是把这个 try/finally 写成"先清理再断言"，导致 2 项假失败）。
try {
  run1 = runSetup('第 1 次 setup');
  run2 = runSetup('第 2 次 setup');

  // ---------- 4. 断言（在清理前采集全部证据）----------
  console.log('\n【断言】');
  check(
    'AC-2.1',
    '两次 setup 均成功（退出码 0）',
    run1.ok && run2.ok,
    `退出码 ${run1.ok ? 0 : '非0'} / ${run2.ok ? 0 : '非0'}；耗时 ${(run1.elapsedMs / 1000).toFixed(1)}s / ${(run2.elapsedMs / 1000).toFixed(1)}s`,
  );

  const rowStillThere = Number(scalar(`select count(*) from jobs where fingerprint='${fingerprint}'`)) === 1;
  check('AC-2.2', '已有数据未丢失（测试行仍在）', rowStillThere, rowStillThere ? '两次 setup 后测试行仍存在' : '测试行消失 → setup 破坏了已有数据');

  const jobsAfter = Number(scalar('select count(*) from jobs'));
  check(
    'AC-2.3',
    'jobs 总行数符合预期（仅 +1 测试行）',
    jobsAfter === jobsBefore + 1,
    `基线 ${jobsBefore} → 现在 ${jobsAfter}（期望 ${jobsBefore + 1}）`,
  );

  const usersAfter = Number(scalar('select count(*) from users'));
  check('AC-2.4', 'users 行数不变（单用户播种未被重复执行）', usersAfter === usersBefore, `基线 ${usersBefore} → 现在 ${usersAfter}`);

  const envAfter = readFileSync(envFile, 'utf8');
  const envMapAfter = parseEnv(envAfter);
  const changedKeys = [...envMapBefore.keys()].filter((key) => envMapAfter.get(key) !== envMapBefore.get(key));
  const addedKeys = [...envMapAfter.keys()].filter((key) => !envMapBefore.has(key));
  check(
    'AC-2.5',
    '.env 已有键值未被覆盖',
    changedKeys.length === 0,
    changedKeys.length === 0
      ? `逐键比对 ${envMapBefore.size} 个键，全部保持不变${addedKeys.length ? `（新增缺失项：${addedKeys.join(', ')}）` : ''}`
      : `被覆盖的键：${changedKeys.join(', ')}`,
  );

  const migrationsAfter = Number(scalar('select count(*) from schema_migrations'));
  check('AC-2.6', '迁移未重复记录', migrationsAfter === migrationsBefore, `基线 ${migrationsBefore} → 现在 ${migrationsAfter}`);
} finally {
  // 证据采集完成后再清理，避免污染用户数据（异常时同样要清理）
  if (!keepTestRow) {
    const cleanup = psql(`delete from jobs where fingerprint='${fingerprint}';`);
    if (!cleanup.ok) console.log(`\n⚠️  清理测试行失败，请手动执行：delete from jobs where fingerprint='${fingerprint}';`);
  }
}

// ---------- 5. 清理确认 ----------
const remaining = Number(scalar(`select count(*) from jobs where fingerprint='${fingerprint}'`));
if (keepTestRow) {
  console.log(`\n（--keep：保留测试行，指纹 ${fingerprint}；手动清理：delete from jobs where fingerprint='${fingerprint}';）`);
} else {
  check('清理', '测试行已删除', remaining === 0, remaining === 0 ? '现场已恢复' : `仍有 ${remaining} 行未清理`);
}

// ---------- 6. 结论 ----------
const failed = checks.filter((c) => !c.ok);
const elapsedText =
  run1 && run2 ? `${(run1.elapsedMs / 1000).toFixed(1)}s / ${(run2.elapsedMs / 1000).toFixed(1)}s` : 'N/A';
console.log('\n══════════════════════════════════════════════════════════════════════');
if (failed.length === 0) {
  console.log(`✅ AC-2 通过：${checks.length}/${checks.length} 项断言成立`);
  console.log(`   可写进评分卡证据：setup 两次均退出 0（${elapsedText}），`);
  console.log(`   已有数据完整、.env 未被覆盖、迁移未重复记录。`);
} else {
  console.log(`❌ AC-2 未通过：${failed.length} 项失败`);
  for (const c of failed) console.log(`   - ${c.id} ${c.name}：${c.detail}`);
}
console.log('══════════════════════════════════════════════════════════════════════');

if (reportPath) {
  const absolute = path.resolve(reportPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${reportLines.join(os.EOL)}${os.EOL}`, 'utf8');
  baseLog(`\n📄 报告已写入：${absolute}（UTF-8）`);
}

process.exit(failed.length === 0 ? 0 : 1);
