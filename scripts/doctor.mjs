#!/usr/bin/env node
/**
 * doctor —— 环境与配置自检（I0 / T6，对应 AC-12）
 *
 * 设计原则：
 * - **只诊断，不自动改**（F-01 §2.5 的默认处理）：每条失败都给"下一步执行什么命令"
 * - 零依赖：只用 Node 内置模块；`.env` 自己解析（不装 dotenv）
 * - 沙箱友好：调用外部命令一律 `stdio: 'ignore'` 只看退出码（管道采集在受限环境会 EPERM）
 * - 无网络模式：`--no-network` 跳过模型连通性探测（用于离线/CI）
 *
 * 用法：node scripts/doctor.mjs [--no-network] [--verbose]
 * 退出码：0 全部通过（可有 ⚠️）；1 存在 ❌
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { formatEnvIssues, validateEnv } from '../src/lib/env.ts';
import { tryCreateLLM } from '../src/lib/llm/index.ts';
import { describeModelProfile } from '../src/lib/llm/profiles.ts';
import { describeTenant, resolveTenant } from '../src/lib/tenant.ts';

const argv = process.argv.slice(2);
const args = new Set(argv);
const noNetwork = args.has('--no-network');
const verbose = args.has('--verbose');
/** 离线核心验收模式：把"依赖 Docker / 数据库"的检查降级为 ⚠️（检查内容不变，只说明本次不计失败） */
const coreOnly = args.has('--core-only');
/** --report <path>：把体检报告以 UTF-8 写入文件，避开 PowerShell 5.1 重定向的编码坑 */
const reportIndex = argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;

// 报告留档：tee console.log 到缓冲区，最后统一写 UTF-8（不要用 PS 的 `*>`）
const reportLines = [];
const baseLog = console.log;
console.log = (...logArgs) => {
  reportLines.push(logArgs.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  baseLog(...logArgs);
};

const results = [];
function record(name, status, detail, fix) {
  results.push({ name, status, detail, fix });
}

/** 解析 .env（不依赖 dotenv）；忽略注释与空行 */
function parseEnvFile(file) {
  const text = readFileSync(file, 'utf8');
  const out = {};
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
    if (value !== '') out[key] = value;
  }
  return out;
}

function hasCommand(cmd, cmdArgs = ['--version']) {
  try {
    const result = spawnSync(cmd, cmdArgs, { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, `连接超时（${timeoutMs}ms）`));
    socket.once('error', (error) => done(false, error.message));
    socket.connect(port, host);
  });
}

function parseDbTarget(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    return { host: url.hostname || '127.0.0.1', port: Number(url.port || 5432) };
  } catch {
    return { host: '127.0.0.1', port: 54322 };
  }
}

async function main() {
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  Profession Search Agent —— doctor（只诊断，不自动修改）      │');
  console.log('└──────────────────────────────────────────────────────────────┘\n');

  // ---------- 1. 运行时 ----------
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) {
    record('Node.js 运行时', 'ok', `v${process.versions.node}（原生支持 TypeScript 类型剥离）`);
  } else {
    record('Node.js 运行时', 'fail', `v${process.versions.node} 过低`, '请升级到 Node 22.6+（推荐 24 LTS）');
  }

  // ---------- 2. .env 与配置校验 ----------
  const envPath = path.resolve('.env');
  let env = null;
  if (!existsSync(envPath)) {
    record('.env 文件', 'fail', '未找到 .env', '运行 npm run setup 生成（不会覆盖已有值）');
  } else {
    const parsed = parseEnvFile(envPath);
    const result = validateEnv(parsed);
    if (result.ok && result.env) {
      env = result.env;
      const warnings = result.issues.filter((i) => i.severity === 'warning');
      record('.env 校验', warnings.length ? 'warn' : 'ok', warnings.length ? `通过，但有 ${warnings.length} 条提示` : '全部字段合法');
      if (warnings.length) console.log(formatEnvIssues(warnings) + '\n');
    } else {
      record('.env 校验', 'fail', `${result.issues.filter((i) => i.severity === 'error').length} 个字段非法`, '按下列提示修正后重跑 doctor');
      console.log(formatEnvIssues(result.issues) + '\n');
    }
  }

  // ---------- 3. Docker 与依赖 ----------
  const hasDocker = hasCommand('docker');
  const hasCompose = hasDocker && hasCommand('docker', ['compose', 'version']);
  // daemon 是否真的在跑：`docker --version` 在 Docker Desktop 未启动时同样成功，
  // 只检查版本号会把"daemon 没启动"误报成 Docker 正常（2026-10-23 实测踩到）。
  const daemonRunning = hasDocker && hasCommand('docker', ['info']);
  if (hasDocker && hasCompose && daemonRunning) {
    record('Docker / Compose', 'ok', 'docker 与 docker compose 均可用，daemon 运行中');
  } else if (hasDocker && hasCompose && !daemonRunning) {
    record(
      'Docker daemon',
      coreOnly ? 'warn' : 'fail',
      'Docker 命令可用，但 **daemon 未运行**（通常是没有启动 Docker Desktop）',
      '启动 Docker Desktop，等托盘图标变绿后重试；自检：docker info 能输出内容',
    );
  } else if (hasDocker) {
    record('Docker / Compose', 'fail', 'docker 可用但 docker compose 不可用', '升级 Docker Desktop 到含 Compose V2 的版本');
  } else {
    record(
      'Docker / Compose',
      coreOnly ? 'warn' : 'fail',
      coreOnly ? '未检测到 docker（--core-only：本次为离线核心验收，不计失败）' : '未检测到 docker 命令',
      '安装 Docker Desktop（Windows/macOS）或 docker engine（Linux）；若只想跑核心逻辑与测试，可忽略此项并用 npm test',
    );
  }

  const composeFile = path.resolve('docker-compose.yml');
  if (existsSync(composeFile)) record('docker-compose.yml', 'ok', '已就绪');
  else record('docker-compose.yml', 'fail', '缺少编排文件', '从仓库恢复 docker-compose.yml');

  // ---------- 4. 数据库连通性 ----------
  if (env) {
    const target = parseDbTarget(env.databaseUrl);
    const probe = await tcpProbe(target.host, target.port);
    if (probe.ok) {
      record('数据库可达性', 'ok', `${target.host}:${target.port} 可连接`);
    } else {
      record(
        '数据库可达性',
        coreOnly ? 'warn' : 'fail',
        `${target.host}:${target.port} 不可达（${probe.reason}）${coreOnly ? '（--core-only：离线核心验收，不计失败）' : ''}`,
        '运行 npm run setup 拉起本地栈；确认端口未被占用',
      );
    }
  } else {
    record('数据库可达性', 'warn', '跳过（.env 未通过校验）', '先修好 .env');
  }

  // ---------- 5. 模型接入（BYOK） ----------
  if (!env) {
    record('模型接入', 'warn', '跳过（.env 未通过校验）', '先修好 .env');
  } else {
    const created = tryCreateLLM(env, { skipProbe: noNetwork });
    if (!created.ok) {
      record('模型接入', 'fail', created.error.message, created.error.userHint);
    } else {
      const service = created.service;
      const status = service.status();
      if (!status.hasCredential) {
        record(
          '模型接入',
          'warn',
          '未配置 API Key：系统可用，但只能走规则模式（L4）',
          '在 .env 填 LLM_API_KEY，或在设置页填写；使用本地 Ollama 时设 ALLOW_PRIVATE_BASE_URL=true',
        );
      } else if (noNetwork) {
        record('模型接入', 'warn', `已配置 ${status.providerLabel} / ${status.model}（--no-network，跳过探测）`, '去掉 --no-network 可验证连通性');
      } else {
        const probe = await service.probe();
        if (probe.ok) {
          record('模型接入', 'ok', `${status.providerLabel} / ${status.model} 连通（${probe.latencyMs}ms）`);
        } else {
          record('模型接入', 'fail', `探测失败：${probe.detail ?? '未知原因'}`, '检查 LLM_API_KEY / LLM_BASE_URL；或改用规则模式');
        }
      }
      // 重新取一次 status：探测成功后 capabilities.source 会变成 'probe'，摘要要反映这一点
      record('能力摘要', 'ok', service.status().capabilitiesText);

      // 视觉模型（F-04 截图识别用，独立于文本模型）
      const visionInfo = describeModelProfile('vision', env);
      if (!visionInfo.configured) {
        record(
          '视觉模型',
          'warn',
          '未配置：截图识别不可用（文本功能不受影响）',
          '需要截图输入时在 .env 加 LLM_VISION_PROVIDER / LLM_VISION_MODEL（可选 LLM_VISION_API_KEY）',
        );
      } else if (!visionInfo.supportsVision) {
        record(
          '视觉模型',
          'fail',
          `${visionInfo.provider} / ${visionInfo.model} 不是视觉模型`,
          `截图识别需要能读图的模型，例如：${visionInfo.suggestions?.join(' / ') ?? 'qwen-vl-plus'}`,
        );
      } else {
        record('视觉模型', 'ok', `${visionInfo.provider} / ${visionInfo.model}（可读图）`);
      }
    }
  }

  // ---------- 6. 安全与隐私 ----------
  if (env) {
    if (env.allowPrivateBaseUrl) {
      record('私网访问', 'warn', 'ALLOW_PRIVATE_BASE_URL=true（允许访问内网模型地址）', '若不使用 Ollama/vLLM，建议改回 false');
    } else {
      record('私网访问', 'ok', '默认拒绝私网地址（防 SSRF）');
    }
    const created = tryCreateLLM(env, { skipProbe: true });
    if (created.ok) {
      const hosts = created.service.status().egressHosts;
      record('出站白名单', hosts.length ? 'ok' : 'fail', hosts.length ? `仅放行：${hosts.join(', ')}` : '白名单为空，所有出站都会被拒绝');
    }
    record(
      '遥测',
      env.langfuseHost ? 'warn' : 'ok',
      env.langfuseHost ? `已开启 LangFuse（${env.langfuseHost}）` : '已关闭（无外发遥测）',
    );
    const tenant = resolveTenant(env);
    record('权限模式', 'ok', describeTenant(tenant));
  }

  // ---------- 输出 ----------
  console.log('体检结果\n');
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  for (const r of results) {
    console.log(`${icon[r.status]} ${r.name}`);
    console.log(`     ${r.detail}`);
    if (r.fix && r.status !== 'ok') console.log(`     → 建议：${r.fix}`);
    if (verbose && r.status === 'ok') console.log('     （通过）');
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  console.log(`\n合计：${results.length} 项检查，${failed} 项失败，${warned} 项提示`);
  if (noNetwork) console.log('（--no-network：已跳过模型连通性探测）');

  if (reportPath) {
    const absolute = path.resolve(reportPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${reportLines.join(os.EOL)}${os.EOL}`, 'utf8');
    baseLog(`\n📄 报告已写入：${absolute}（UTF-8）`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

await main();
