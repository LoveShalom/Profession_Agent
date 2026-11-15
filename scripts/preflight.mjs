/**
 * 环境体检（F-09 / I4 T5）
 *
 * `npm run preflight`：只检查、不修改。逐项给出「OK / 警告 / 阻塞」与可执行的修复命令。
 * 目标：让"干净机器一键启动"从口号变成可验证的流程（I4 出口标准之一）。
 *
 * 用法：node scripts/preflight.mjs [--json]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';

const asJson = process.argv.includes('--json');
const results = [];
const line = (status, name, detail, fix) => {
  results.push({ status, name, detail, fix });
  const icon = status === 'ok' ? '✔' : status === 'warn' ? '⚠' : '✖';
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
  if (fix && status !== 'ok') console.log(`   → ${fix}`);
};

function run(command, args, options = {}) {
  try {
    return { ok: true, output: execFileSync(command, args, { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim() };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'UNKNOWN', output: '' };
  }
}

// ---------------------------------------------------------------- Node
const major = Number(process.versions.node.split('.')[0]);
line(major >= 20 ? 'ok' : 'error', 'Node 版本', `v${process.versions.node}（要求 ≥ 20）`, '升级 Node：https://nodejs.org/');

// ---------------------------------------------------------------- 依赖
line(
  existsSync('node_modules') ? 'ok' : 'error',
  '依赖已安装',
  existsSync('node_modules') ? 'node_modules 存在' : '缺少 node_modules',
  '运行 npm install',
);

// ---------------------------------------------------------------- .env
if (!existsSync('.env')) {
  line('error', '.env 配置', '文件不存在', '复制 .env.example 为 .env 后填写 LLM_API_KEY / ENCRYPTION_KEY / DATABASE_URL');
} else {
  const envText = readFileSync('.env', 'utf8');
  const keys = ['DATABASE_URL', 'LLM_PROVIDER', 'LLM_MODEL', 'ENCRYPTION_KEY'];
  const missing = keys.filter((key) => !new RegExp(`^${key}=.+`, 'm').test(envText));
  line(
    missing.length === 0 ? 'ok' : 'warn',
    '.env 必填键',
    missing.length === 0 ? '齐全' : `缺少 ${missing.join('、')}`,
    '运行 npm run setup（会补齐缺失键并生成密钥）',
  );
  const hasLlmKey = /^LLM_API_KEY=.+/m.test(envText);
  line(
    hasLlmKey ? 'ok' : 'warn',
    'LLM Key',
    hasLlmKey ? '已配置' : '未配置（仍可用规则模式 L4，字段多为待确认）',
    '在 .env 或 /settings/llm 配置；DeepSeek 文本用 deepseek-chat、视觉用 deepseek-flash',
  );
}

// ---------------------------------------------------------------- Docker / 数据层
const dockerVersion = run('docker', ['--version']);
if (!dockerVersion.ok && dockerVersion.code === 'EPERM') {
  // 沙箱/受限环境：不是"没装"，而是不允许启动子进程 —— 不能误报成"未安装"
  line('warn', 'Docker 检查', '当前环境禁止启动子进程（沙箱），跳过 Docker 检测', '在普通终端运行 npm run preflight');
} else if (!dockerVersion.ok) {
  line('warn', 'Docker', '未安装或不在 PATH（可用外部 Postgres 代替）', '安装 Docker Desktop 后运行 docker compose up -d');
} else {
  line('ok', 'Docker CLI', dockerVersion.output);
  const dockerInfo = run('docker', ['info']);
  line(
    dockerInfo.ok ? 'ok' : 'error',
    'Docker daemon',
    dockerInfo.ok ? '正在运行' : 'daemon 未运行（docker --version 成功不代表 daemon 在跑）',
    '启动 Docker Desktop 后重试',
  );
}

// ---------------------------------------------------------------- 端口（54322）
const port = Number((readFileSync('.env', 'utf8').match(/DATABASE_URL=.*?:(\d+)\//)?.[1] ?? '0') || 54322);
await new Promise((resolve) => {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
    line('ok', `数据库端口 ${port}`, '可连接');
    socket.end();
    resolve();
  });
  socket.setTimeout(2500);
  socket.on('timeout', () => {
    socket.destroy();
    line('warn', `数据库端口 ${port}`, '连不上（Docker 未启动或端口不同）', 'docker compose up -d');
    resolve();
  });
  socket.on('error', () => {
    line('warn', `数据库端口 ${port}`, '连不上', 'docker compose up -d');
    resolve();
  });
});

// ---------------------------------------------------------------- 迁移

try {
  const { default: pg } = await import('pg');
  const databaseUrl = (readFileSync('.env', 'utf8').match(/^DATABASE_URL=(.+)$/m)?.[1] ?? '').trim();
  if (databaseUrl.length > 0) {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const result = await pool.query('select count(*)::int as n from schema_migrations').catch(() => null);
    await pool.end().catch(() => undefined);
    if (result === null) {
      line('warn', '数据库迁移', 'schema_migrations 不存在（新库首次需要迁移）', 'node scripts/migrate.mjs');
    } else {
      const count = Number(result.rows[0].n);
      line(count >= 7 ? 'ok' : 'warn', '数据库迁移', `已应用 ${count} 个（期望 ≥ 7）`, 'node scripts/migrate.mjs');
      if (count < 7) migrationHint = 'node scripts/migrate.mjs';
    }
  }
} catch (error) {
  line('warn', '数据库迁移', error instanceof Error ? error.message : '检查失败', 'node scripts/migrate.mjs');
}

// ---------------------------------------------------------------- 汇总
const blocking = results.filter((item) => item.status === 'error');
const warnings = results.filter((item) => item.status === 'warn');
console.log(`\n结果：${results.length - blocking.length - warnings.length} 项正常、${warnings.length} 项提醒、${blocking.length} 项阻塞`);

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else if (blocking.length === 0) {
  console.log('\n✅ 可以启动：npm run dev');
  console.log('   入口：/（首页） · /jobs/new（粘贴 JD） · /jobs/board（看板） · /experiences（经历库） · /settings/llm（模型）');
} else {
  console.log('\n✖ 先解决阻塞项再启动。');
}

process.exit(blocking.length === 0 ? 0 : 1);
