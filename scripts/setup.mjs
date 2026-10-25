#!/usr/bin/env node
/**
 * setup —— 一键启动（I0 / T3，对应 AC-1 / AC-2）
 *
 * 契约（F-01 §1.2-B）：
 *   - **幂等**：重复执行不重置数据、不覆盖 .env 里已有值，只补缺失项
 *   - 参数：--dry-run（只检查不执行）、--no-pull（跳过镜像拉取）、--port <n>、--yes、--verbose
 *   - 退出码：0 成功；2 前置条件不满足（如无 Docker）；1 运行期失败
 *
 * 沙箱/受限环境友好：所有外部命令用 `stdio: 'ignore'` 只看退出码（管道采集会 EPERM）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { generateEncryptionKey } from '../src/lib/env.ts';
import { applyMissingEnvKeys } from '../src/lib/server/env-file.ts';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const dryRun = has('--dry-run');
const noPull = has('--no-pull');
const verbose = has('--verbose');
const port = Number(valueOf('--port', '3000'));

const steps = [];
function step(name, status, detail) {
  steps.push({ name, status, detail });
  const icon = { ok: '✅', skip: '⏭️ ', fail: '❌', warn: '⚠️ ' }[status];
  console.log(`${icon} ${name}${detail ? ` —— ${detail}` : ''}`);
}

function run(cmd, cmdArgs, options = {}) {
  // 交互终端下透传 docker / 迁移的输出（镜像拉取进度、SQL 报错都能看到）；
  // 非 TTY（CI / 受限沙箱）退回 ignore。
  // options.quiet：轮询类探测（如 pg_isready）即使 TTY 也不输出，否则会刷屏。
  const showOutput = !options.quiet && (verbose || Boolean(process.stdout.isTTY));
  const result = spawnSync(cmd, cmdArgs, { stdio: showOutput ? 'inherit' : 'ignore' });
  return { ok: result.status === 0, status: result.status, error: result.error };
}

/**
 * 在容器内用 pg_isready 判断"真正的 Postgres 是否就绪"。
 *
 * 为什么不能只用 TCP：Docker Desktop 的端口转发会在容器内服务尚未启动时就**先接受**
 * 发往 127.0.0.1:54322 的 TCP 连接（2026-10-21 实测踩坑）。于是 TCP 探测会假阳性，
 * 让迁移抢跑，psql 报 `socket "/var/run/postgresql/.s.PGSQL.5432" ... No such file or directory`。
 * pg_isready 在容器内执行、只看退出码，比 TCP 更接近真实可用性。
 */
function pgIsReady() {
  return run('docker', ['compose', 'exec', '-T', 'db', 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { quiet: true }).ok;
}

async function waitForPgReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    if (pgIsReady()) return { ok: true, attempts };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, attempts };
}

function commandExists(cmd, cmdArgs = ['--version']) {
  try {
    return run(cmd, cmdArgs).ok;
  } catch {
    return false;
  }
}

function portFree(targetPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(targetPort, '127.0.0.1');
  });
}

function waitForTcp(host, targetPort, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = new net.Socket();
      const finish = (ok) => {
        socket.destroy();
        if (ok) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 1000);
      };
      socket.setTimeout(1500);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(targetPort, host);
    };
    attempt();
  });
}

/** 读取 .env（若不存在则从模板生成）；只补缺失值，绝不覆盖已有非空值 */
function ensureEnvFile() {
  const envPath = path.resolve('.env');
  const examplePath = path.resolve('.env.example');
  if (!existsSync(examplePath)) throw new Error('缺少 .env.example 模板，无法生成 .env');

  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(examplePath, 'utf8');
  const created = !existsSync(envPath);
  const changes = [];

  const currentValue = (key) => {
    const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : undefined;
  };
  const upsert = (key, value) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text = `${text.trimEnd()}\n${key}=${value}\n`;
  };

  // 必填项 1：ENCRYPTION_KEY（为空才生成）
  if (!currentValue('ENCRYPTION_KEY')) {
    upsert('ENCRYPTION_KEY', generateEncryptionKey());
    changes.push('ENCRYPTION_KEY（自动生成）');
  }
  // 必填项 2：DATABASE_URL（模板已有默认值；缺失才补）
  if (!currentValue('DATABASE_URL')) {
    upsert('DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    changes.push('DATABASE_URL（补默认值）');
  }

  // 通用补键：模板里有、当前 .env 里完全没有的键（如新增的 LLM_VISION_* / WORKSPACE_DIR）
  // 只补键名缺失的，已有键（即使值为空）一律不动 —— 与"不覆盖已有值"的幂等约定一致。
  const templateText = readFileSync(examplePath, 'utf8');
  const merged = applyMissingEnvKeys(text, templateText);
  if (merged.added.length > 0) {
    text = merged.text;
    changes.push(`补缺失键：${merged.added.join(', ')}`);
  }
  // 端口
  if (Number.isFinite(port) && port > 0) {
    if (currentValue('APP_PORT') !== String(port)) {
      upsert('APP_PORT', String(port));
      changes.push(`APP_PORT=${port}`);
    }
    if (currentValue('NEXT_PUBLIC_APP_URL') !== `http://localhost:${port}`) {
      upsert('NEXT_PUBLIC_APP_URL', `http://localhost:${port}`);
      changes.push(`NEXT_PUBLIC_APP_URL=http://localhost:${port}`);
    }
  }

  if (!dryRun) writeFileSync(envPath, text, 'utf8');
  return { created, changes, envPath };
}

async function main() {
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  Profession Search Agent —— setup（幂等，可重复执行）         │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  if (dryRun) console.log('（--dry-run：只检查，不修改文件、不启动容器）\n');

  // ---------- 步骤 1：前置条件 ----------
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    step('Node.js 版本', 'fail', `v${process.versions.node} 过低，需要 22.6+`);
    return finish(2);
  }
  step('Node.js 版本', 'ok', `v${process.versions.node}`);

  // ---------- 步骤 2：.env（与 Docker 无关，先准备好，便于离线跑测试与 doctor）----------
  const envInfo = ensureEnvFile();
  step('.env', 'ok', envInfo.created ? '已从模板生成' : '已存在（仅补缺失项）');
  if (envInfo.changes.length) step('.env 补全', 'ok', envInfo.changes.join('、'));

  // ---------- 步骤 3：Docker 前置检查 ----------
  const hasDocker = commandExists('docker');
  const hasCompose = hasDocker && commandExists('docker', ['compose', 'version']);
  if (!hasDocker) {
    step('Docker', 'fail', '未检测到 docker 命令');
    console.log('\n安装指引：https://docs.docker.com/get-docker/');
    console.log('提示：.env 已就绪，可先执行 npm test 与 npm run doctor --no-network（无需数据库）。');
    return finish(2);
  }
  if (!hasCompose) {
    step('Docker Compose', 'fail', 'docker 可用但 compose 不可用');
    return finish(2);
  }
  step('Docker', 'ok', 'docker 与 docker compose 可用');

  // daemon 检查：`docker --version` 在 Docker Desktop 未启动时也会成功，
  // 若不做这一步，后面会"等待数据库 120 秒后超时"，并给出误导性的 initdb 提示。
  if (!run('docker', ['info'], { quiet: true }).ok) {
    step('Docker daemon', 'fail', 'Docker 命令可用，但 daemon 未运行（通常是没启动 Docker Desktop）');
    console.log('\n请先启动 Docker Desktop，等托盘图标变绿后重试。自检：');
    console.log('  docker info          # 能输出内容 = daemon 正常');
    console.log('  npm run setup        # 再执行本脚本');
    console.log('Windows 常见原因：Docker Desktop 未启动 / WSL2 后端异常 / 系统刚重启尚未就绪。');
    return finish(2);
  }
  step('Docker daemon', 'ok', 'daemon 运行中');

  const free = await portFree(port);
  if (!free) {
    step(`端口 ${port}`, 'fail', '已被占用（不会静默换端口）');
    console.log(`\n请释放该端口，或使用：npm run setup -- --port ${port + 1}`);
    return finish(2);
  }
  step(`端口 ${port}`, 'ok', '可用');

  // ---------- 步骤 4：启动数据层 ----------
  if (dryRun) {
    step('启动容器', 'skip', 'dry-run 跳过');
    step('等待数据库', 'skip', 'dry-run 跳过');
    step('应用迁移', 'skip', 'dry-run 跳过');
    step('健康检查', 'skip', 'dry-run 跳过');
    return finish(0);
  }

  // 注意 flag 必须放在 service 名之前（compose 各版本对"flag 在位置参数之后"容忍度不同）
  const upArgs = ['compose', 'up', '-d'];
  if (!noPull) upArgs.push('--pull', 'missing');
  upArgs.push('db');
  const up = run('docker', upArgs);
  if (!up.ok) {
    step('启动容器', 'fail', 'docker compose up 失败');
    console.log('\n排查建议：docker compose logs db；或运行 npm run doctor');
    return finish(1);
  }
  step('启动容器', 'ok', 'db 已启动（pgvector + Postgres）');

  // ---------- 步骤 4：等待数据库就绪 ----------
  // 先做一次 TCP 探测（快），再用容器内 pg_isready 确认真实就绪（TCP 会被 Docker Desktop 骗）。
  await waitForTcp('127.0.0.1', 54322, 15_000);
  const pgReady = await waitForPgReady(120_000);
  if (!pgReady.ok) {
    step('等待数据库', 'fail', `120s 内 pg_isready 未通过（探测 ${pgReady.attempts} 次）`);
    console.log('\n排查建议：docker compose logs db（首次启动 initdb 较慢）；确认端口 54322 未被占用');
    return finish(1);
  }
  step('等待数据库', 'ok', `pg_isready 通过（探测 ${pgReady.attempts} 次），127.0.0.1:54322 可连接`);

  // ---------- 步骤 5：迁移 ----------
  // 首次启动由 postgres 镜像自动执行 /docker-entrypoint-initdb.d 下的 SQL；
  // 后续增量迁移走 migrate.mjs（同样不依赖 stdin 管道）。
  const migrate = run(process.execPath, ['scripts/migrate.mjs']);
  step(
    '应用迁移',
    migrate.ok ? 'ok' : 'warn',
    migrate.ok
      ? '迁移已应用或已是最新'
      : '未确认 —— 这通常意味着某个 SQL 执行失败；请运行 npm run db:migrate 查看具体报错',
  );

  // ---------- 步骤 6：健康检查 ----------
  let healthy = false;
  try {
    const response = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    healthy = response.ok;
  } catch {
    healthy = false;
  }
  if (healthy) {
    step('健康检查', 'ok', `http://localhost:${port}/api/health 正常`);
  } else {
    step('健康检查', 'warn', '应用尚未启动（首次需先安装依赖并构建）');
  }

  return finish(0);
}

function finish(code) {
  console.log('\n──────── 下一步 ────────');
  console.log('1) 配置模型（可选，不配也能用）：编辑 .env 里的 LLM_PROVIDER / LLM_API_KEY / LLM_MODEL');
  console.log('2) 安装依赖并启动应用：npm install && npm run dev');
  console.log(`3) 打开 http://localhost:${port}`);
  console.log('4) 自检：npm run doctor');
  console.log('\n扩展说明：migrations 目录已挂载到容器 /docker-entrypoint-initdb.d，首次启动自动建表。');
  process.exit(code);
}

await main();
