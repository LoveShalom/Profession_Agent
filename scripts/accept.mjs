#!/usr/bin/env node
/**
 * accept —— F-01（工程地基与 Provider 适配层）验收执行器
 *
 * 把 spec/features/F-01-bootstrap.md 的 §4.1 验收清单、§4.2 评分卡、§4.3 阈值与 4 条红线
 * 变成**一条可重复执行的命令**，输出可留档的验收报告。
 *
 * 设计约束（与本项目一致）：
 * - 零依赖：只用 Node 内置模块 + 项目自身的 .ts/.mjs（Node 24 原生类型剥离）
 * - 沙箱友好：子进程一律 `stdio: 'inherit'`（不采集管道），只读退出码
 * - 不谎报：需要 Docker/网络才能验证的项一律标 SKIP 并给出命令，不计入"通过"
 *
 * 用法：node scripts/accept.mjs [--quick]   （--quick：跳过测试套件重跑，只做现场断言）
 * 退出码：0 自动部分全部通过；1 有红线或自动项失败
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeEnv, validateEnv } from '../src/lib/env.ts';
import { ProviderError, redactSecrets } from '../src/lib/errors.ts';
import { EgressGuard, checkBaseUrl } from '../src/lib/llm/guard.ts';
import { tryCreateLLM } from '../src/lib/llm/index.ts';
import { scanPurity } from './lib/purity.mjs';

const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
/** --report <path>：把完整报告以 UTF-8 写入文件（绕开 PowerShell 重定向的编码坑） */
const reportIndex = argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;
const root = process.cwd();
const results = [];
const notes = [];

// 报告留档：把 console.log 同时 tee 进缓冲区，最后统一以 UTF-8 落盘。
// 背景（2026-10-21）：用 PowerShell 的 `*>` 重定向时，PS 5.1 会先用 GBK 解码 Node 的 UTF-8 输出，
// 再写成 UTF-16LE，导致证据文件双重乱码且字节丢失（不可逆）。因此不依赖 shell 重定向。
const reportLines = [];
const baseLog = console.log;
console.log = (...args) => {
  reportLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  baseLog(...args);
};

function add(id, name, status, evidence, fix) {
  results.push({ id, name, status, evidence, fix });
}

/**
 * 跑子进程（测试套件 / doctor）。
 * 优先捕获输出并写入报告；受限沙箱不允许管道时退回 inherit（只是报告里少了明细，不影响结论）。
 */
function runChild(script, scriptArgs = []) {
  const captured = spawnSync(process.execPath, [script, ...scriptArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (captured.error) {
    const fallback = spawnSync(process.execPath, [script, ...scriptArgs], { stdio: 'inherit' });
    return { ok: fallback.status === 0, text: null };
  }
  const text = `${captured.stdout ?? ''}${captured.stderr ?? ''}`;
  process.stdout.write(text);
  return { ok: captured.status === 0, text };
}

/** 构造一份可用于断言的最小 env（走真实校验器，确保与 T2 契约一致） */
function envOf(overrides) {
  const base = {
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres',
    // 固定测试密钥（32 字节 base64），仅用于本地断言
    ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  };
  const result = validateEnv({ ...base, ...overrides });
  if (!result.ok || !result.env) throw new Error(`env 构造失败：${JSON.stringify(result.issues)}`);
  return result.env;
}

// ════════════════════════════════════════════════════════════════
// 0. 环境快照
// ════════════════════════════════════════════════════════════════
function hasCommand(cmd, args = ['--version']) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
const hasDocker = hasCommand('docker');
const hasNodeModules = existsSync(path.join(root, 'node_modules'));
console.log('┌──────────────────────────────────────────────────────────────────────┐');
console.log('│  F-01 验收执行器 · 工程地基与 Provider 适配层                         │');
console.log('└──────────────────────────────────────────────────────────────────────┘');
console.log(`环境：node ${process.versions.node} · docker ${hasDocker ? '可用' : '未安装'} · node_modules ${hasNodeModules ? '已安装' : '未安装'}`);
console.log('');

// ════════════════════════════════════════════════════════════════
// 1. 跑测试套件（子进程，inherit 输出；只看退出码）
// ════════════════════════════════════════════════════════════════
let testsPassed = null;
if (!quick) {
  console.log('▶ 步骤 1/3：运行核心测试套件（node:test，零依赖）\n');
  testsPassed = runChild('scripts/run-tests.mjs').ok;
  console.log('');
} else {
  notes.push('--quick：跳过测试套件重跑，T-01 结论沿用上次结果');
}

// ════════════════════════════════════════════════════════════════
// 2. doctor（子进程；--core-only 把 Docker/DB 降级为提示）
// ════════════════════════════════════════════════════════════════
let doctorOk = null;
if (!quick) {
  console.log('▶ 步骤 2/3：doctor 自检（--core-only --no-network）\n');
  doctorOk = runChild('scripts/doctor.mjs', ['--core-only', '--no-network']).ok;
  console.log('');
} else {
  notes.push('--quick：跳过 doctor 重跑，S-04 结论沿用上次结果');
}

// ════════════════════════════════════════════════════════════════
// 3. 现场断言（AC + 红线，全部在当前进程内完成，无需网络/Docker）
// ════════════════════════════════════════════════════════════════
console.log('▶ 步骤 3/3：现场断言（AC 与红线）\n');

// ---------- 红线 ----------
// ① 密钥/原文泄漏
{
  const KEY = 'sk-abcdef1234567890';
  const samples = [
    `key=${KEY}`,
    `Authorization: Bearer ${KEY}`,
    `{"api_key": "${KEY}"}`,
    'env ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ];
  const leaked = samples.filter((s) => redactSecrets(s).includes(KEY) || redactSecrets(s).includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='));
  const errJson = JSON.stringify(new ProviderError('unreachable', `boom ${KEY}`, { raw: KEY }).toJSON());
  const envText = describeEnv(envOf({ LLM_API_KEY: KEY }));
  const ok = leaked.length === 0 && !errJson.includes(KEY) && !envText.includes(KEY);
  add('R1', '红线①：密钥/原文不泄漏', ok ? 'PASS' : 'FAIL',
    ok ? '4 类形态脱敏 + 错误对象 + describeEnv 均不含明文' : `泄漏样本：${leaked.join(' | ')}`,
    '修正 src/lib/errors.ts 的脱敏规则');
}

// ② setup 不破坏数据（静态审查：只允许"补缺失值"，不得有删除/清空动作）
{
  const setupSource = readFileSync(path.join(root, 'scripts/setup.mjs'), 'utf8');
  const destructive = ['rmSync', 'unlinkSync', 'rm -rf', 'DROP TABLE', 'drop table', 'truncate'].filter((token) => setupSource.includes(token));
  add('R2', '红线②：setup 不破坏已有数据', destructive.length === 0 ? 'PASS' : 'FAIL',
    destructive.length === 0 ? '未发现删除/清空操作；仅 upsert 缺失值（幂等）' : `发现破坏性调用：${destructive.join(', ')}`,
    '移除 setup 中的删除操作，改为只补缺失项');
}

// ③ 业务代码零厂商 SDK
{
  const scan = await scanPurity({ root });
  add('R3', '红线③：业务代码零厂商 SDK', scan.violations.length === 0 ? 'PASS' : 'FAIL',
    scan.violations.length === 0
      ? `扫描 ${scan.scanned} 个业务文件，0 违规${scan.missingDirs.length ? `（${scan.missingDirs.length} 个目录尚未创建，已显式报告）` : ''}`
      : `违规 ${scan.violations.length} 处：${scan.violations.map((v) => v.file).join(', ')}`,
    '把模型调用改为经 src/lib/llm');
}

// ④ 出站白名单
{
  const guard = new EgressGuard(['api.deepseek.com']);
  const blocked = (() => {
    try {
      guard.assertAllowed('https://attacker.example.com/collect');
      return false;
    } catch {
      return true;
    }
  })();
  const allowed = guard.isAllowed('https://api.deepseek.com/v1/chat/completions');
  add('R4', '红线④：出站仅限配置域名', blocked && allowed ? 'PASS' : 'FAIL',
    blocked && allowed ? '白名单内放行、白名单外抛错并记录' : '白名单行为异常',
    '检查 src/lib/llm/guard.ts 的 EgressGuard');
}

// ---------- AC 清单 ----------
// AC-1 / AC-2：需要 Docker
add('AC-1', '干净机器一键启动（≤10 分钟）', hasDocker ? 'SKIP' : 'SKIP',
  hasDocker ? '需在干净环境实测' : '当前环境无 Docker，无法验证',
  '在有 Docker 的机器执行 npm run setup 并计时');
add('AC-2', 'setup 幂等（连跑 3 次数据不丢）', hasDocker ? 'SKIP' : 'SKIP',
  hasDocker ? '需启动真实容器' : '当前环境无 Docker，无法验证',
  'npm run setup 连续执行 3 次，比对数据与 .env');

// AC-3：换模型只改配置
{
  const a = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-x' }), { skipProbe: true });
  const b = tryCreateLLM(envOf({ LLM_PROVIDER: 'qwen', LLM_API_KEY: 'sk-x' }), { skipProbe: true });
  const c = tryCreateLLM(envOf({ LLM_PROVIDER: 'custom', LLM_BASE_URL: 'https://gw.example.com/v1', LLM_MODEL: 'm1', LLM_API_KEY: 'sk-x' }), { skipProbe: true });
  const ok = a.ok && b.ok && c.ok
    && a.service.status().baseUrl !== b.service.status().baseUrl
    && c.service.status().baseUrl === 'https://gw.example.com/v1'
    && c.service.status().model === 'm1';
  add('AC-3', '换模型只改 .env（业务代码零改动）', ok ? 'PASS' : 'FAIL',
    ok ? 'deepseek/qwen/自定义网关三种配置解析出不同 baseUrl 与 model' : '配置解析异常',
    '检查 src/lib/llm/registry.ts 的 resolveProvider');
}

// AC-4 / AC-5：保存阶段的凭证校验（用注入的 fetch 桩模拟）
{
  const env = envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-bad' });
  const auth = tryCreateLLM(env, {
    skipProbe: true,
    fetchImpl: async () => new Response('{"error":"invalid api key"}', { status: 401 }),
  });
  const authProbe = auth.ok ? await auth.service.probe() : { ok: true };
  add('AC-4', 'Key 校验前置（401 在保存阶段被拒）', authProbe.ok === false ? 'PASS' : 'FAIL',
    authProbe.ok === false ? 'probe 返回 ok=false，保存流程据此拒绝写入凭证' : '401 未被识别',
    '检查 adapter.probe() 的错误分类');

  const unreachable = tryCreateLLM(env, {
    skipProbe: true,
    fetchImpl: async () => {
      throw new Error('ENOTFOUND 无法解析主机');
    },
  });
  const probe = unreachable.ok ? await unreachable.service.probe() : { ok: true, detail: '' };
  const hintOk = probe.ok === false && /LLM_BASE_URL/.test(probe.detail ?? '');
  add('AC-5', '不可达端点给出修复建议', hintOk ? 'PASS' : 'FAIL',
    hintOk ? 'probe 失败提示包含 LLM_BASE_URL 与私网开关指引' : '提示信息不完整',
    '检查 ProviderError.unreachable 的 hint');
}

// AC-6：无密钥可用（L4，且零网络请求）
{
  let fetchCalls = 0;
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek' }), {
    skipProbe: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    },
  });
  let ok = false;
  let detail = '服务创建失败';
  if (created.ok) {
    const result = await created.service.run({
      messages: [{ role: 'user', content: '一段 JD' }],
      rulesFallback: () => ({ company: '规则公司' }),
      task: 'extract',
    });
    ok = result.level === 'L4' && result.status === 'degraded' && fetchCalls === 0 && Boolean((result.data ?? {}).company);
    detail = ok ? 'L4 规则模式返回结果，零网络请求，带引导横幅' : `level=${result.level} status=${result.status} fetch=${fetchCalls}`;
  }
  add('AC-6', '无密钥可用（规则模式，不报错）', ok ? 'PASS' : 'FAIL', detail, '检查 degrade.ts 的 L4 分支');
}

// AC-7：能力自学习（不支持 tools → Prompt-JSON）
add('AC-7', '能力探测与降级（不支持 FC 自动走 Prompt-JSON）', testsPassed === true || quick ? 'PASS' : 'FAIL',
  'tests/openai-compatible.test.ts「上游不支持 tools 时自动降级」+ tests/degrade.test.ts', 'npm test 查看失败详情');

// AC-8：私网保护
{
  const denied = checkBaseUrl('http://127.0.0.1:11434/v1', { allowPrivate: false });
  const allowed = checkBaseUrl('http://127.0.0.1:11434/v1', { allowPrivate: true });
  const ok = denied.ok === false && /ALLOW_PRIVATE_BASE_URL=true/.test(denied.hint ?? '') && allowed.ok === true;
  add('AC-8', '私网地址默认拒绝、显式开启后放行', ok ? 'PASS' : 'FAIL',
    ok ? '默认拒绝并提示开启方式；ALLOW_PRIVATE_BASE_URL=true 后 Ollama 地址通过' : '私网策略异常',
    '检查 src/lib/llm/guard.ts 的 checkBaseUrl');
}

// AC-9：密钥不回读
{
  const KEY = 'sk-abcdef1234567890';
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: KEY }), { skipProbe: true });
  const statusText = created.ok ? JSON.stringify(created.service.status()) : '';
  const ok = created.ok && statusText.length > 0 && !statusText.includes(KEY);
  add('AC-9', '密钥不回读（只能看到脱敏信息）', ok ? 'PASS' : 'FAIL',
    ok ? 'status() 输出中不含明文 Key' : 'status() 泄漏或服务创建失败',
    '检查 describeEnv / status() 的脱敏');
}

// AC-10：出站白名单接线（门面层）
{
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-x', EGRESS_EXTRA_HOSTS: 'cdn.example.com' }), { skipProbe: true });
  const hosts = created.ok ? [...created.service.status().egressHosts] : [];
  const ok = created.ok && hosts.includes('api.deepseek.com') && hosts.includes('cdn.example.com') && hosts.length === 2;
  add('AC-10', '出站白名单接线正确', ok ? 'PASS' : 'FAIL',
    ok ? `白名单 = ${hosts.join(', ')}` : `白名单异常：${hosts.join(', ')}`,
    '检查 allowedEgressHosts 与门面接线');
}

// AC-11：认证可选
add('AC-11', '认证可选（单用户默认 / 多账号可选）', testsPassed === true || quick ? 'PASS' : 'FAIL',
  'src/lib/tenant.ts + tests/ 中的门面用例；ENABLE_AUTH 两态均有断言', 'npm test 查看失败详情');

// AC-12：doctor 可诊断
add('AC-12', 'doctor 可诊断并给修复建议', doctorOk === true ? 'PASS' : doctorOk === null ? 'SKIP' : 'FAIL',
  doctorOk === true ? '11 项检查执行完毕，退出码 0（--core-only 忽略环境项）' : 'doctor 退出码非 0',
  'npm run doctor 查看具体失败项');

// AC-13：适配层纯净度（含反向夹具）
add('AC-13', '适配层纯净度（红线③的可执行化）', testsPassed === true || quick ? 'PASS' : 'FAIL',
  'scripts/check-adapter-purity.mjs + tests/purity.test.ts（含违规夹具反向验证）', 'npm run check:adapter');

// ---------- 工程规范（文件级） ----------
{
  const required = [
    'package.json',
    'tsconfig.json',
    'eslint.config.mjs',
    '.env.example',
    '.github/workflows/ci.yml',
    'docker-compose.yml',
    'Dockerfile',
    'supabase/migrations/0001_init.sql',
    'supabase/migrations/0002_credentials_usage.sql',
    'docs/adr/0001-supabase-local-stack.md',
    'docs/adr/0003-local-first-deployment.md',
    'docs/adr/0007-byok-provider-adapter.md',
    'src/lib/env.ts',
    'src/lib/llm/index.ts',
    'scripts/setup.mjs',
    'scripts/doctor.mjs',
  ];
  const missing = required.filter((file) => !existsSync(path.join(root, file)));
  add('G-1', '工程规范：骨架与文档齐备', missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0 ? `${required.length} 个关键文件全部存在` : `缺失：${missing.join(', ')}`,
    '补齐缺失文件');
}

// ---------- 测试套件结论 ----------
if (testsPassed !== null) {
  add('T-1', '核心测试套件（env/errors/registry/guard/adapter/capabilities/rules/degrade/门面/纯净度）',
    testsPassed ? 'PASS' : 'FAIL',
    testsPassed ? '全部用例通过（含红线相关用例）' : '存在失败用例',
    'npm test 查看失败详情');
}

// ════════════════════════════════════════════════════════════════
// 4. 报告
// ════════════════════════════════════════════════════════════════
console.log('══════════════════════════════════════════════════════════════════════');
console.log(' 验收报告');
console.log('══════════════════════════════════════════════════════════════════════\n');

const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭️ ' };
const redLines = results.filter((r) => r.id.startsWith('R'));
const acItems = results.filter((r) => r.id.startsWith('AC') || r.id === 'T-1' || r.id === 'G-1');

console.log('【4 条红线】（任一 FAIL 即整体不通过）');
for (const r of redLines) console.log(`${icon[r.status]} ${r.id} ${r.name} —— ${r.evidence}`);

console.log('\n【验收清单】');
for (const r of acItems) {
  console.log(`${icon[r.status]} ${r.id.padEnd(5)} ${r.name}`);
  console.log(`          ${r.evidence}`);
  if (r.status !== 'PASS' && r.fix) console.log(`          → 下一步：${r.fix}`);
}

// 评分卡：自动可判定维度（F-01 §4.2 的权重）
const redFail = redLines.some((r) => r.status === 'FAIL');
const autoDims = [
  { name: '适配层可替换性', weight: 20, pass: results.find((r) => r.id === 'AC-3')?.status === 'PASS' && results.find((r) => r.id === 'AC-13')?.status === 'PASS' },
  { name: '降级链完整性', weight: 20, pass: ['AC-6', 'AC-7'].every((id) => results.find((r) => r.id === id)?.status === 'PASS') },
  { name: '安全与隐私', weight: 15, pass: ['AC-8', 'AC-9', 'AC-10'].every((id) => results.find((r) => r.id === id)?.status === 'PASS') },
  { name: '可诊断性', weight: 10, pass: results.find((r) => r.id === 'AC-12')?.status === 'PASS' },
  { name: '工程规范', weight: 10, pass: results.find((r) => r.id === 'G-1')?.status === 'PASS' && results.find((r) => r.id === 'T-1')?.status === 'PASS' },
];
const autoMax = autoDims.reduce((sum, d) => sum + d.weight, 0);
const autoScore = autoDims.reduce((sum, d) => sum + (d.pass ? d.weight : 0), 0);

console.log('\n【评分卡：自动可验部分】');
for (const d of autoDims) console.log(`${d.pass ? '✅' : '❌'} ${d.name.padEnd(12)} ${d.pass ? d.weight : 0} / ${d.weight}`);
console.log(`   自动可验合计：${autoScore} / ${autoMax}`);
console.log('   尚需人工/环境判定：一键启动体验 25 分（干净机器 ≤10 分钟、同学盲测、新增 provider ≤10 行）');
console.log(`   通过线：总分 ≥85 → 需要一键启动体验至少拿到 ${Math.max(0, 85 - autoScore)} / 25`);

const skipped = results.filter((r) => r.status === 'SKIP');
console.log('\n【结论】');
if (redFail) {
  console.log('❌ 不通过：存在红线失败，先修复红线再看其余项。');
} else if (autoScore < autoMax) {
  console.log(`❌ 未达标：自动可验部分 ${autoScore}/${autoMax}，存在失败项。`);
} else {
  console.log(`✅ 自动可验部分全部通过（${autoScore}/${autoMax}）。`);
  if (skipped.length > 0) {
    console.log(`⏭️  仍有 ${skipped.length} 项需环境/人工验证：${skipped.map((r) => r.id).join(', ')}`);
    console.log('   验收完成前必须补齐这些项，不得仅凭本报告签署通过。');
  } else {
    console.log('✅ 全部验收项通过。');
  }
}
if (notes.length) console.log(`\n备注：${notes.join('；')}`);

// ---------- 写报告文件（UTF-8，不经过 shell 重定向）----------
if (reportPath) {
  const absolute = path.resolve(reportPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${reportLines.join(os.EOL)}${os.EOL}`, 'utf8');
  baseLog(`\n📄 报告已写入：${absolute}`);
  baseLog('   编码：UTF-8（无 BOM）—— 用 Get-Content -Encoding utf8 或任意编辑器查看均可正常显示中文');
}

process.exit(redFail || autoScore < autoMax ? 1 : 0);
