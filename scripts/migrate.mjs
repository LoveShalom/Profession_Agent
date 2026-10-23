#!/usr/bin/env node
/**
 * migrate —— 应用数据库迁移（I0 / T7）
 *
 * 设计取舍：
 * - 迁移 SQL 全部写成**幂等**（create table if not exists / drop policy if exists / create or replace /
 *   on conflict do nothing），因此本脚本每次都按文件名顺序全量执行，不需要读取"已应用列表"。
 * - 不通过管道采集 psql 输出（受限沙箱会 EPERM），只用退出码判断，并把失败项打印出来。
 * - 首次启动时 postgres 镜像会自动执行 /docker-entrypoint-initdb.d（compose 已挂载该目录），
 *   本脚本用于**增量**与显式重放。
 *
 * 用法：node scripts/migrate.mjs [--dry-run]
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dryRun = process.argv.includes('--dry-run');
const MIGRATIONS_DIR = path.resolve('supabase/migrations');
const CONTAINER_DIR = '/docker-entrypoint-initdb.d';

function run(cmd, cmdArgs, options = {}) {
  // 交互终端下把 psql / docker 的输出直接透传：迁移失败时用户能立刻看到真实 SQL 错误。
  // 非 TTY（CI / 受限沙箱）下退回 ignore——这些环境不允许捕获管道。
  // options.quiet：轮询类探测（pg_isready）不输出，避免刷屏。
  const showOutput = !options.quiet && (process.argv.includes('--verbose') || Boolean(process.stdout.isTTY));
  const result = spawnSync(cmd, cmdArgs, { stdio: showOutput ? 'inherit' : 'ignore' });
  return { ok: result.status === 0, status: result.status };
}

/** 容器内 pg_isready：比 TCP 探测可靠（Docker Desktop 会提前接受 TCP，导致假阳性） */
function pgIsReady() {
  return run('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { quiet: true }).ok;
}

async function waitForPgReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let attempts = 0;
  let announced = false;
  while (Date.now() < deadline) {
    attempts += 1;
    if (pgIsReady()) return { ok: true, attempts };
    // 只在"确实需要等"时才提示，避免就绪瞬间也打印一行让人误以为卡住
    if (!announced && Date.now() - startedAt > 1500) {
      console.log('⏳ 等待 Postgres 就绪（首次启动需 initdb，通常十几秒）…');
      announced = true;
    } else if (announced && attempts % 10 === 0) {
      console.log(`   …仍在等待（已 ${Math.round((Date.now() - startedAt) / 1000)}s）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, attempts };
}

/**
 * 执行一条 psql 命令，只对「连接失败」重试。
 *
 * psql 退出码语义：0 成功 / 1 自身致命错误 / 2 **连接不上** / 3 脚本执行错误（配 ON_ERROR_STOP）。
 * 因此仅 status === 2 时重试（通常是容器还在 initdb），SQL 真错了（3）立即失败、不掩盖问题。
 */
async function psqlWithRetry(args, { retries = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const result = run('docker', ['compose', 'exec', '-T', 'db', 'psql', ...args]);
    if (result.ok) return { ok: true, attempts: attempt };
    if (result.status !== 2) return { ok: false, status: result.status, attempts: attempt };
    if (attempt < retries) {
      if (attempt % 5 === 1) console.log(`⏳ 数据库暂不可连接，重试中…（${attempt}/${retries}）`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { ok: false, status: 2, attempts: retries };
}

function dockerAvailable() {
  try {
    return run('docker', ['--version']).ok;
  } catch {
    return false;
  }
}

/**
 * docker 命令在 ≠ daemon 在跑。
 * `docker --version` 在 Docker Desktop 未启动时也会成功（它只打客户端版本），
 * 于是后续 psql/exec 全部报 "cannot find the file specified / npipe"，表现为"等 120 秒然后超时"。
 * 这里提前探测 daemon，做到**快速失败 + 可操作提示**（2026-10-23 实测踩到）。
 */
function dockerDaemonRunning() {
  try {
    return run('docker', ['info'], { quiet: true }).ok;
  } catch {
    return false;
  }
}

async function main() {
  let files = [];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    console.error(`✖ 找不到迁移目录：${MIGRATIONS_DIR}`);
    process.exit(2);
  }

  if (files.length === 0) {
    console.error('✖ 迁移目录为空');
    process.exit(2);
  }

  console.log(`▶ 待应用迁移 ${files.length} 个（幂等，可重复执行）`);
  for (const file of files) console.log(`   - ${file}`);

  if (dryRun) {
    console.log('\n（--dry-run：未执行）');
    return;
  }

  if (!dockerAvailable()) {
    console.log('\n⚠️  未检测到 docker，无法自动迁移。');
    console.log('   手动方式（任选其一）：');
    console.log('   1) 启动 db 容器后，postgres 会自动执行挂载到 /docker-entrypoint-initdb.d 的迁移');
    console.log('   2) 用 psql 直接执行：psql "$DATABASE_URL" -f supabase/migrations/' + files[0]);
    process.exit(2);
  }

  if (!dockerDaemonRunning()) {
    console.log('\n❌ Docker 命令可用，但 **daemon 未运行**（通常是没有启动 Docker Desktop）。');
    console.log('   请先启动 Docker Desktop，等托盘图标变绿（或等 `docker info` 能输出内容）后重试。');
    console.log('   自检命令：');
    console.log('     docker info                                # 能输出内容 = daemon 正常');
    console.log('     docker compose up -d                       # 再启动数据层');
    console.log('     npm run db:migrate                         # 再执行迁移');
    console.log('   Windows 常见原因：Docker Desktop 未启动 / WSL2 后端异常 / 系统刚重启尚未就绪。');
    process.exit(2);
  }

  // 等数据库真正就绪（TCP 探测会被 Docker Desktop 骗，见 setup.mjs 的注释）
  const ready = await waitForPgReady(120_000);
  if (!ready.ok) {
    console.log(`\n❌ 120s 内 Postgres 未就绪（探测 ${ready.attempts} 次）`);
    console.log('   首次启动需要 initdb，可能较慢；请检查：docker compose logs db');
    process.exit(2);
  }

  // 让增量迁移也有记录可查（幂等）
  const ensure = await psqlWithRetry([
    '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
    '-c',
    'create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now());',
  ]);
  if (!ensure.ok) {
    console.log(`\n❌ 无法创建 schema_migrations（退出码 ${ensure.status}）`);
    process.exit(1);
  }

  let failed = 0;
  for (const file of files) {
    const result = await psqlWithRetry([
      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
      '-f', `${CONTAINER_DIR}/${file}`,
    ]);
    if (result.ok) {
      await psqlWithRetry([
        '-U', 'postgres', '-d', 'postgres', '-c',
        `insert into schema_migrations (filename) values ('${file}') on conflict (filename) do nothing;`,
      ]);
      console.log(`✅ ${file}${result.attempts > 1 ? `（连接重试 ${result.attempts - 1} 次后成功）` : ''}`);
    } else {
      failed += 1;
      console.log(`❌ ${file}（退出码 ${result.status}）`);
    }
  }

  console.log(
    failed === 0
      ? '\n✅ 全部迁移已应用'
      : [
          `\n❌ ${failed} 个迁移失败`,
          '排查顺序：',
          '  1) 加 --verbose 重跑，直接看 psql 的原始报错：node scripts/migrate.mjs --verbose',
          '  2) 看容器日志：docker compose logs db',
          '  3) 若报错提到 authenticated 角色或 auth.uid()：说明迁移里混入了 Supabase 专有语法',
          '     （精简 Postgres 栈必须用 DO 块守卫，见 supabase/migrations/0001_init.sql 末尾）',
        ].join('\n'),
  );
  process.exit(failed === 0 ? 0 : 1);
}

await main();
