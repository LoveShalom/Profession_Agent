#!/usr/bin/env node
/**
 * 模型错误路径验收（阶段 3A）—— 不需要真实 API Key、不需要改 .env、不需要网络
 *
 * 存在意义：AC-4 / AC-5 / AC-8 验的是"错误发生时系统怎么反应"，用**注入的 fetch 桩**
 * 就能精确构造 401 / 403 / 404 / DNS 失败等场景，比手工改 .env + 依赖真实网络更可靠、可重复。
 *
 * 手工改 .env 三次的问题（2026-10-21 实测踩到）：
 *   · 容易漏改/改错行（编辑器可能存成 .env.txt）
 *   · 每次都要还原，稍不留神污染真实配置
 *   · 结果依赖当时的网络状况，不可重复
 *
 * 用法：node scripts/verify-model-errors.mjs
 * 退出码：0 全部通过；1 有失败项
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { generateEncryptionKey, validateEnv } from '../src/lib/env.ts';
import { checkBaseUrl } from '../src/lib/llm/guard.ts';
import { tryCreateLLM } from '../src/lib/llm/index.ts';

const results = [];
function check(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${id} ${name}`);
  console.log(`     ${detail}`);
}

/** 构造一份可断言的 env（走真实校验器，随机密钥避免落盘） */
function envOf(overrides = {}) {
  const result = validateEnv({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres',
    ENCRYPTION_KEY: generateEncryptionKey(),
    ...overrides,
  });
  if (!result.ok || !result.env) throw new Error(`env 构造失败：${JSON.stringify(result.issues)}`);
  return result.env;
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status });
const messageOf = (probe) => `${probe.detail ?? ''}`;

console.log('┌──────────────────────────────────────────────────────────────────────┐');
console.log('│  模型错误路径验收（AC-4 / AC-5 / AC-8 / AC-10 / AC-6）                │');
console.log('│  不需要真实 Key、不联网、不修改 .env                                  │');
console.log('└──────────────────────────────────────────────────────────────────────┘\n');

// ---------- 1. AC-4：401 Key 无效 → 探测阶段即拒绝 ----------
{
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-invalid-1234' }), {
    skipProbe: true,
    fetchImpl: async () => jsonResponse(401, { error: { message: 'invalid api key' } }),
  });
  const probe = created.ok ? await created.service.probe() : { ok: true, detail: '' };
  const detail = messageOf(probe);
  check(
    'AC-4a',
    '401（Key 无效）→ 探测失败，保存阶段即可拒绝',
    probe.ok === false,
    probe.ok === false ? `探测返回失败：${detail || '（已捕获）'}` : '401 未被识别为凭证错误',
  );
}

// ---------- 2. AC-4：403 权限不足 ----------
{
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-no-perm' }), {
    skipProbe: true,
    fetchImpl: async () => jsonResponse(403, { error: { message: 'forbidden' } }),
  });
  const probe = created.ok ? await created.service.probe() : { ok: true, detail: '' };
  check('AC-4b', '403（权限不足）→ 探测失败', probe.ok === false, probe.ok === false ? '已识别为凭证/权限错误' : '403 未被识别');
}

// ---------- 3. AC-5：网络不可达 → 给出 LLM_BASE_URL 修复建议 ----------
{
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-x' }), {
    skipProbe: true,
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND api.deepseek.com');
    },
  });
  const probe = created.ok ? await created.service.probe() : { ok: true, detail: '' };
  const detail = messageOf(probe);
  const actionable = /LLM_BASE_URL/.test(detail) && /ALLOW_PRIVATE_BASE_URL/.test(detail);
  check(
    'AC-5',
    '网络不可达 → 失败并提示检查 LLM_BASE_URL / 私网开关',
    probe.ok === false && actionable,
    probe.ok === false ? `提示可操作：${actionable ? '含 LLM_BASE_URL 与私网开关指引' : `缺失关键指引（${detail}）`}` : '不可达未被识别',
  );
}

// ---------- 4. AC-5：404 模型名写错 → 提示检查模型名 ----------
{
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'custom', LLM_BASE_URL: 'https://gw.example.com/v1', LLM_MODEL: 'no-such-model', LLM_API_KEY: 'sk-x' }), {
    skipProbe: true,
    fetchImpl: async () => jsonResponse(404, { error: { message: 'model not found' } }),
  });
  const probe = created.ok ? await created.service.probe() : { ok: true, detail: '' };
  const detail = messageOf(probe);
  check(
    'AC-5b',
    '404（模型名错误）→ 探测失败并提示模型名',
    probe.ok === false && /模型|model/i.test(detail),
    probe.ok === false ? `提示与模型名相关：${/模型|model/i.test(detail) ? '是' : `否（${detail}）`}` : '404 未被识别',
  );
}

// ---------- 5. AC-8：私网地址默认拒绝，显式开启后放行 ----------
{
  const denied = checkBaseUrl('http://127.0.0.1:11434/v1', { allowPrivate: false });
  const allowed = checkBaseUrl('http://127.0.0.1:11434/v1', { allowPrivate: true });
  const ok = denied.ok === false && /ALLOW_PRIVATE_BASE_URL=true/.test(denied.hint ?? '') && allowed.ok === true;
  check(
    'AC-8',
    '私网地址默认拒绝，ALLOW_PRIVATE_BASE_URL=true 后放行（Ollama）',
    ok,
    ok ? '默认拒绝并给出开启方式；显式开启后通过' : '私网策略异常',
  );
}

// ---------- 6. AC-10：出站白名单在门面层生效 ----------
{
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-x', EGRESS_EXTRA_HOSTS: 'cdn.example.com' }), { skipProbe: true });
  if (!created.ok) {
    check('AC-10', '出站白名单生效', false, `服务创建失败：${created.error.message}`);
  } else {
    const guard = created.service.egressGuard;
    const allowProvider = guard.isAllowed('https://api.deepseek.com/v1/chat/completions');
    const allowExtra = guard.isAllowed('https://cdn.example.com/x');
    const denyOther = !guard.isAllowed('https://attacker.example.com/collect');
    check('AC-10', '出站白名单：放行配置域名、拦截其他域名', allowProvider && allowExtra && denyOther,
      `provider=${allowProvider} extra=${allowExtra} 拦截未知=${denyOther}`);
  }
}

// ---------- 7. AC-6：无 Key 时零网络请求、走 L4 ----------
{
  let fetchCalls = 0;
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek' }), {
    skipProbe: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(200, {});
    },
  });
  if (!created.ok) {
    check('AC-6', '无 Key → 规则模式且零网络请求', false, `服务创建失败：${created.error.message}`);
  } else {
    const result = await created.service.run({
      messages: [{ role: 'user', content: '一段 JD' }],
      rulesFallback: () => ({ company: '规则公司' }),
      task: 'extract',
    });
    const ok = result.level === 'L4' && fetchCalls === 0 && Boolean(result.data);
    check('AC-6', '无 Key → 规则模式（L4）且零网络请求', ok, `level=${result.level} fetchCalls=${fetchCalls}`);
  }
}

// ---------- 8. 脱敏：错误信息不泄漏密钥 ----------
{
  const KEY = 'sk-leak-check-1234567890';
  const created = tryCreateLLM(envOf({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: KEY }), {
    skipProbe: true,
    fetchImpl: async () => {
      throw new Error(`upstream said: invalid key ${KEY}`);
    },
  });
  const probe = created.ok ? await created.service.probe() : { detail: '' };
  const leaked = JSON.stringify(probe).includes(KEY);
  check('脱敏', '探测失败信息中不泄漏明文 Key', !leaked, leaked ? '发现明文 Key！' : '错误信息已脱敏');
}

// ---------- 当前 .env 的实际解析结果（用于确认配置真的生效）----------
console.log('\n──────────────── 当前 .env 解析结果（Key 已脱敏）────────────────');
const envPath = path.resolve('.env');
if (!existsSync(envPath)) {
  console.log('⚠️ 未找到 .env（不影响上面的检查，但应用启动需要它）');
} else {
  const parsed = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value !== '') parsed[key] = value;
  }
  const result = validateEnv(parsed);
  if (!result.ok || !result.env) {
    console.log('❌ .env 校验未通过：');
    for (const issue of result.issues.filter((i) => i.severity === 'error')) console.log(`   - ${issue.key}: ${issue.message}`);
  } else {
    const env = result.env;
    const created = tryCreateLLM(env, { skipProbe: true });
    if (!created.ok) {
      console.log(`❌ 无法据此创建服务：${created.error.message}`);
      console.log(`   → ${created.error.userHint}`);
    } else {
      const status = created.service.status();
      console.log(`   provider   = ${status.provider}（${status.providerLabel}）`);
      console.log(`   model      = ${status.model}`);
      console.log(`   baseUrl    = ${status.baseUrl}`);
      console.log(`   API Key    = ${status.hasCredential ? '已设置（脱敏不可读）' : '未设置 → 规则模式 L4'}`);
      console.log(`   能力       = ${status.capabilitiesText}`);
      console.log(`   出站白名单 = ${status.egressHosts.join(', ') || '（空）'}`);
      if (!status.hasCredential) {
        console.log('\n   ℹ️ 要验证真实连通性（阶段 3B），需在 .env 设置 LLM_API_KEY；');
        console.log('      可用下面的命令（不会经过编辑器，避免存成 .env.txt）：');
        console.log('      $lines = Get-Content .env');
        console.log("      $lines = $lines -replace '^LLM_API_KEY=.*$', 'LLM_API_KEY=你的真实Key'");
        console.log('      [System.IO.File]::WriteAllLines((Join-Path $PWD ".env"), $lines)');
      }
    }
  }
}

// ---------- 汇总 ----------
const passed = results.filter((r) => r.ok).length;
console.log(`\n合计：${passed}/${results.length} 通过`);
if (passed !== results.length) {
  console.log('失败项说明见上；这些检查全部离线完成，失败通常意味着适配层错误分类或提示信息有缺陷。');
}
process.exit(passed === results.length ? 0 : 1);
