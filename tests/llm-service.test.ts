import test from 'node:test';
import assert from 'node:assert/strict';

import { generateEncryptionKey, validateEnv } from '../src/lib/env.ts';
import type { Env } from '../src/lib/env.ts';
import { tryCreateLLM } from '../src/lib/llm/index.ts';
import type { ChatMessage, SchemaLike } from '../src/lib/llm/types.ts';

const KEY = generateEncryptionKey();

/** 通过真实的 env 校验器构造 Env，确保门面与 T2 契约一致 */
function makeEnv(overrides: Record<string, string> = {}): Env {
  const result = validateEnv({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres',
    ENCRYPTION_KEY: KEY,
    ...overrides,
  });
  assert.equal(result.ok, true, `env 构造失败：${JSON.stringify(result.issues)}`);
  return result.env!;
}

const schema: SchemaLike<{ company: string }> = {
  jsonSchema: { type: 'object', properties: { company: { type: 'string' } } },
  describe: () => 'company: string',
  parse: (input) => input as { company: string },
  safeParse: (input) => ({ success: true, data: input as { company: string } }),
};

const messages: ChatMessage[] = [{ role: 'user', content: '一段 JD' }];

function modelsOk(): Response {
  return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 });
}
function toolCallOk(company: string): Response {
  return new Response(
    JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ company }) } }] } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    }),
    { status: 200 },
  );
}

test('AC-3：业务侧只改 .env 就能换模型——门面从 env 解析出 provider/model/地址', () => {
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'qwen', LLM_API_KEY: 'sk-x' }), { now: () => 0 });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  const status = service.status();
  assert.equal(status.provider, 'qwen');
  assert.equal(status.model, 'qwen-plus');
  assert.equal(status.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(status.hasCredential, true);
  assert.deepEqual(status.egressHosts, ['dashscope.aliyuncs.com']);
});

test('AC-3：显式覆盖 base_url / model 生效（自定义中转站场景）', () => {
  const created = tryCreateLLM(
    makeEnv({
      LLM_PROVIDER: 'custom',
      LLM_BASE_URL: 'https://gateway.example.com/v1',
      LLM_MODEL: 'my-model',
      LLM_API_KEY: 'sk-x',
      EGRESS_EXTRA_HOSTS: 'cdn.example.com',
    }),
    { now: () => 0 },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  const status = service.status();
  assert.equal(status.baseUrl, 'https://gateway.example.com/v1');
  assert.equal(status.model, 'my-model');
  assert.deepEqual(status.egressHosts, ['cdn.example.com', 'gateway.example.com']);
});

test('AC-6：未配置 Key 时服务仍可创建，run() 走 L4 规则模式且零网络请求', async () => {
  let fetchCalls = 0;
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'deepseek' }), {
    now: () => 0,
    fetchImpl: async () => {
      fetchCalls += 1;
      return modelsOk();
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  assert.equal(service.hasCredential, false);

  const result = await service.run<{ company: string }>({
    messages,
    schema,
    rulesFallback: () => ({ company: '规则公司' }),
    task: 'extract',
  });
  assert.equal(result.level, 'L4');
  assert.equal(result.status, 'degraded');
  assert.equal(result.data?.company, '规则公司');
  assert.equal(fetchCalls, 0, 'L4 不应发起任何网络请求');
  assert.equal(service.tracker.snapshot().counts.L4, 1);
});

test('Ollama：无 Key 也算"有凭证"（本地模型），但私网地址默认被拒（AC-8）', () => {
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'ollama' }), { now: () => 0 });
  assert.equal(created.ok, false);
  if (created.ok) return;
  assert.equal(created.error.kind, 'config');
  assert.match(created.error.userHint, /ALLOW_PRIVATE_BASE_URL=true/);
});

test('Ollama（AC-8）：显式开启私网后可用，且无 Key 也能调用', async () => {
  const created = tryCreateLLM(
    makeEnv({ LLM_PROVIDER: 'ollama', ALLOW_PRIVATE_BASE_URL: 'true' }),
    {
      now: () => 0,
      fetchImpl: async (url) => (String(url).endsWith('/models') ? modelsOk() : toolCallOk('Ollama 本地公司')),
    },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  assert.equal(service.hasCredential, true, 'keyOptional 的 provider 无 Key 也可用');
  assert.deepEqual(service.status().egressHosts, ['127.0.0.1']);

  const result = await service.run<{ company: string }>({
    messages,
    schema,
    rulesFallback: () => ({ company: '规则公司' }),
    task: 'extract',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.data?.company, 'Ollama 本地公司');
});

test('AC-3 + L0：配好 Key 后 run() 走 tool calling，并记录 L0', async () => {
  const calls: string[] = [];
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-test-key' }), {
    now: () => 0,
    fetchImpl: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return String(url).endsWith('/models') ? modelsOk() : toolCallOk('AI 公司');
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;

  const result = await service.run<{ company: string }>({
    messages,
    schema,
    rulesFallback: () => ({ company: '规则公司' }),
    task: 'extract',
  });
  assert.equal(result.level, 'L0');
  assert.equal(result.path, 'tool_calling');
  assert.equal(result.data?.company, 'AI 公司');
  assert.equal(service.tracker.snapshot().counts.L0, 1);
  assert.equal(calls.length, 2, '先探测能力，再执行抽取');
  assert.match(calls[0]!, /GET .*\/models$/);
});

test('probe()：无凭证时返回 ok=false 并说明处于规则模式', async () => {
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'deepseek' }), { now: () => 0 });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  const probe = await service.probe();
  assert.equal(probe.ok, false);
  assert.match(probe.detail ?? '', /规则模式/);
});

test('probe()：有效 Key 时 ok=true 并刷新能力来源', async () => {
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-test-key' }), {
    now: () => 0,
    fetchImpl: async () => modelsOk(),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  const probe = await service.probe();
  assert.equal(probe.ok, true);
  assert.equal(service.capabilities().source, 'probe');
});

test('skipProbe（离线）：不发探测请求，能力用预设默认值', async () => {
  let fetchCalls = 0;
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-test-key' }), {
    now: () => 0,
    skipProbe: true,
    fetchImpl: async () => {
      fetchCalls += 1;
      return toolCallOk('离线公司');
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  const result = await service.run<{ company: string }>({
    messages,
    schema,
    rulesFallback: () => ({ company: '规则公司' }),
  });
  assert.equal(result.data?.company, '离线公司');
  assert.equal(fetchCalls, 1, '仅执行 1 次抽取，无探测请求');
  assert.equal(service.capabilities().source, 'default');
});

test('AC-4：401 时 run() 走 L3，且 status() 能反映降级统计', async () => {
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-bad' }), {
    now: () => 0,
    skipProbe: true,
    fetchImpl: async () => new Response('{"error":"invalid key"}', { status: 401 }),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  const result = await service.run<{ company: string }>({
    messages,
    schema,
    rulesFallback: () => ({ company: '规则公司' }),
  });
  assert.equal(result.level, 'L3');
  assert.match(result.banner ?? '', /API Key 失效/);
  assert.equal(service.status().degradation.counts.L3, 1);
  assert.equal(service.status().degradation.degradedRate, 1);
});

test('AC-10：出站白名单在门面层生效（未授权域名请求被拦）', async () => {
  // 让 provider 指向 A 域名，但 guard 只放行 A；这里验证 guard 被真实接线
  const created = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-test-key' }), {
    now: () => 0,
    skipProbe: true,
    fetchImpl: async () => toolCallOk('公司'),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  assert.equal(service.egressGuard.isAllowed('https://api.deepseek.com/v1/chat/completions'), true);
  assert.equal(service.egressGuard.isAllowed('https://attacker.example.com/collect'), false);
});

test('tryCreateLLM：配置错误（custom 缺 base_url）不抛异常，返回可读错误', () => {
  const result = tryCreateLLM(makeEnv({ LLM_PROVIDER: 'custom' }), { now: () => 0 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.kind, 'config');
  assert.match(result.error.userHint, /LLM_BASE_URL/);
});

test('status()：输出人可读能力摘要与脱敏信息（不含密钥）', () => {
  const created = tryCreateLLM(
    makeEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-supersecret-value' }),
    { now: () => 0, skipProbe: true },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const service = created.service;
  const status = service.status();
  assert.match(status.capabilitiesText, /source=default/);
  assert.equal(JSON.stringify(status).includes('sk-supersecret-value'), false);
});
