/**
 * 本地一键启动（F-09 延伸：把"终端命令"变成"双击"）
 *
 * 做四件事（幂等，可重复运行）：
 *   1. 确保数据层：Docker daemon 没起就尝试拉起 Docker Desktop，再 `docker compose up -d db`
 *   2. 等数据库端口就绪（从 .env 的 DATABASE_URL 解析）
 *   3. 跑迁移（幂等）：node scripts/migrate.mjs
 *   4. 有构建产物就直接 next start；没有（或 --rebuild）先 build
 * 最后自动打开浏览器。
 *
 * 用法：
 *   node scripts/local-start.mjs                 # 默认：localhost:3000
 *   node scripts/local-start.mjs --lan           # 允许局域网访问（手机/平板）
 *   node scripts/local-start.mjs --rebuild       # 强制重新构建
 *   node scripts/local-start.mjs --port=3100
 *   node scripts/local-start.mjs --dry-run       # 只打印将要执行的步骤
 *   node scripts/local-start.mjs --setup-only    # 只准备环境（数据层+迁移），不启动应用
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (prefix, fallback) => {
  const hit = argv.find((arg) => arg.startsWith(`--${prefix}=`));
  return hit ? hit.slice(prefix.length + 3) : fallback;
};

const LAN = flag('lan');
const REBUILD = flag('rebuild');
const DRY = flag('dry-run');
const SETUP_ONLY = flag('setup-only');
const PORT = Number(value('port', '3000'));
const ROOT = process.cwd();

const log = (message) => console.log(message);
const step = (message) => console.log(`\n▶ ${message}`);

function run(command, args, options = {}) {
  if (DRY) {
    log(`   [dry-run] ${command} ${args.join(' ')}`);
    return { ok: true, output: '' };
  }
  const result = spawnSync(command, args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    cwd: ROOT,
    ...options,
  });
  return {
    ok: result.status === 0,
    output: String(result.stdout ?? '').trim() || String(result.stderr ?? '').trim(),
    code: result.error?.code,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 递归找源码/配置的最新修改时间（用于判断构建产物是否过期） */
function newestSourceMtime(dir = path.join(ROOT, 'src')) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(full));
    } else {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** 构建产物是否落后于源码（改代码后忘记 rebuild 是常见坑） */
function buildIsStale() {
  const buildId = path.join(ROOT, '.next', 'BUILD_ID');
  if (!existsSync(buildId)) return { stale: true, reason: '没有构建产物' };
  const builtAt = statSync(buildId).mtimeMs;
  const configs = ['package.json', 'next.config.mjs', 'tsconfig.json']
    .map((name) => path.join(ROOT, name))
    .filter((full) => existsSync(full))
    .map((full) => statSync(full).mtimeMs);
  const newestSource = Math.max(newestSourceMtime(), ...configs);
  if (newestSource > builtAt + 1000) {
    const minutes = Math.round((newestSource - builtAt) / 60000);
    return { stale: true, reason: `源码比构建新约 ${minutes} 分钟（改了代码没重新 build）` };
  }
  return { stale: false, reason: '' };
}

function databaseUrl() {
  try {
    const env = readFileSync(path.join(ROOT, '.env'), 'utf8');
    return env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function parseTarget(url) {
  const match = /@([^:/]+):(\d+)\//.exec(url);
  return match ? { host: match[1], port: Number(match[2]) } : { host: '127.0.0.1', port: 54322 };
}

async function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        resolve(true);
      });
      socket.setTimeout(1500);
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => resolve(false));
    });
    if (ok) return true;
    await sleep(1500);
  }
  return false;
}

// ---------------------------------------------------------------- 0. 前置检查
step('检查运行环境');
if (!existsSync(path.join(ROOT, 'node_modules'))) {
  log('✖ 缺少 node_modules：先运行 npm install');
  process.exit(2);
}
if (!existsSync(path.join(ROOT, '.env'))) {
  log('⚠ 缺少 .env：先用 npm run setup 生成');
  process.exit(2);
}
log('✔ 依赖与 .env 就绪');

// ---------------------------------------------------------------- 1. Docker / 数据层
step('准备数据层（Postgres + pgvector）');
const dockerInfo = run('docker', ['info'], { capture: true });
if (dockerInfo.ok) {
  log('✔ Docker daemon 正在运行');
} else if (dockerInfo.code === 'EPERM') {
  log('⚠ 当前环境禁止启动子进程（沙箱），跳过 Docker 检测，直接尝试连接数据库');
} else {
  log('⚠ Docker daemon 未运行，尝试启动 Docker Desktop…');
  if (process.platform === 'win32' && !DRY) {
    const candidates = [
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Docker', 'Docker Desktop.exe'),
    ];
    const exe = candidates.find((item) => existsSync(item));
    if (exe) {
      spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
      log('   已触发 Docker Desktop 启动，等待就绪（最多 120 秒）…');
      for (let index = 0; index < 40; index += 1) {
        await sleep(3000);
        if (run('docker', ['info'], { capture: true }).ok) break;
      }
    } else {
      log('   ✖ 没找到 Docker Desktop，请手动启动后重试');
    }
  }
}
const up = run('docker', ['compose', 'up', '-d', 'db'], { capture: true });
if (up.ok) log('✔ 数据层容器已启动（psa-db）');
else if (up.code === 'EPERM') log('⚠ 无法执行 docker（环境受限）；如果已有外部 Postgres 就忽略');
else log(`⚠ docker compose 启动失败：${up.output.slice(0, 300)}`);

// ---------------------------------------------------------------- 2. 等端口
const target = parseTarget(databaseUrl());
step(`等待数据库 ${target.host}:${target.port}`);
const ready = DRY ? true : await waitPort(target.host, target.port, 60_000);
log(ready ? '✔ 数据库端口可连接' : '⚠ 数据库端口连不上（若是外部数据库，请检查 .env）');

// ---------------------------------------------------------------- 3. 迁移
step('应用数据库迁移（幂等）');
if (ready) {
  const migrate = run('node', ['scripts/migrate.mjs'], { capture: false });
  log(migrate.ok ? '✔ 迁移完成' : '⚠ 迁移失败（可手动 npm run db:migrate 查看原因）');
} else {
  log('⚠ 跳过迁移（数据库不可达）');
}

if (SETUP_ONLY) {
  log('\n✅ 环境已就绪（--setup-only，未启动应用）');
  process.exit(0);
}

// ---------------------------------------------------------------- 4. 构建
const staleness = buildIsStale();
if (REBUILD || staleness.stale) {
  const reason = REBUILD ? '--rebuild 指定' : staleness.reason;
  step(`构建（${reason}；约 1–2 分钟）`);
  const build = run('npx', ['next', 'build'], { capture: false });
  if (!build.ok) {
    log('✖ 构建失败，请查看上面的报错；也可以先用 npm run dev 调试');
    process.exit(1);
  }
  log('✔ 构建完成');
} else {
  log('\n✔ 构建产物是最新的，跳过构建');
}

// ---------------------------------------------------------------- 5. 启动
step('启动应用');
const host = LAN ? '0.0.0.0' : '127.0.0.1';
const url = `http://${LAN ? 'localhost' : '127.0.0.1'}:${PORT}`;
log(`   地址：${url}`);
if (LAN) {
  log('   局域网访问：在手机/平板打开 http://<这台电脑的IP>:' + PORT + '（首次需允许防火墙）');
}
log('   关闭此窗口 = 停止应用');

if (!DRY) {
  await sleep(1500);
  const open = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  // 延迟到服务起来再开浏览器
  setTimeout(() => {
    spawn(open[0], open[1], { stdio: 'ignore', detached: true }).unref();
  }, 3000);
}

if (DRY) {
  log(`   [dry-run] npx next start -p ${PORT} -H ${host}`);
  log('\n✅ dry-run 结束（未执行任何命令）');
  process.exit(0);
}

const child = spawn('npx', ['next', 'start', '-p', String(PORT), '-H', host], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  cwd: ROOT,
});
child.on('exit', (code) => process.exit(code ?? 0));
