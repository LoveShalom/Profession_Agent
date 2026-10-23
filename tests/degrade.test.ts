import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderError } from '../src/lib/errors.ts';
import { DegradationTracker, runWithDegradation } from '../src/lib/llm/degrade.ts';
import { createOpenAICompatibleAdapter } from '../src/lib/llm/openai-compatible.ts';
import type { Capabilities, ProviderAdapter, ProviderConfig, SchemaLike } from '../src/lib/llm/types.ts';

const CAPS: Capabilities = {
  tool_calling: true,
  json_schema: false,
  stream: true,
  embedding: true,
  context_window: 32768,
  max_output: 4096,
  source: 'declared',
};

const config: ProviderConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
  timeoutMs: 50,
  maxRetries: 0,
  allowPrivateBaseUrl: false,
  capabilities: CAPS,
};

const schema: SchemaLike<{ company: string }> = {
  jsonSchema: { type: 'object', properties: { company: { type: 'string' } } },
  describe: () => 'company: string',
  parse: (input) => input as { company: string },
  safeParse: (input) =>
    typeof input === 'object' && input !== null && typeof (input as { company?: unknown }).company === 'string'
      ? { success: true, data: input as { company: string } }
      : { success: false, error: 'company 应为字符串' },
};

const messages = [{ role: 'user' as const, content: '一段 JD' }];
const rulesFallback = () => ({ company: '规则模式公司' });

/** 用一个"总是抛指定错误"的适配器来验证降级分流 */
function throwingAdapter(error: unknown): ProviderAdapter {
  const base = createOpenAICompatibleAdapter(config, { sleep: async () => {}, now: () => 0 });
  const fail = async () => {
    throw error;
  };
  return { ...base, chatJSON: fail as ProviderAdapter['chatJSON'], chat: fail as ProviderAdapter['chat'] };
}

test('L4：未配置凭证 → 规则模式 + 引导横幅，且不触碰适配器', async () => {
  const result = await runWithDegradation<{ company: string }>({
    hasCredential: false,
    messages,
    schema,
    rulesFallback,
  });
  assert.equal(result.level, 'L4');
  assert.equal(result.status, 'degraded');
  assert.equal(result.degraded, true);
  assert.equal(result.path, 'rules');
  assert.deepEqual(result.data, { company: '规则模式公司' });
  assert.match(result.banner ?? '', /尚未配置模型/);
});

test('L0：tool calling 路径成功 → 不降级', async () => {
  const adapter = createOpenAICompatibleAdapter(config, {
    sleep: async () => {},
    now: () => 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ function: { arguments: '{"company":"AI 公司"}' } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      ),
  });
  const result = await runWithDegradation<{ company: string }>({ hasCredential: true, adapter, messages, schema, rulesFallback });
  assert.equal(result.level, 'L0');
  assert.equal(result.path, 'tool_calling');
  assert.equal(result.status, 'ok');
  assert.equal(result.degraded, false);
  assert.equal(result.data?.company, 'AI 公司');
  assert.equal(result.banner, undefined);
});

test('L1：Prompt-JSON 路径成功 → level 标记为 L1，不算降级', async () => {
  const adapter = createOpenAICompatibleAdapter(
    { ...config, capabilities: { ...CAPS, tool_calling: false } },
    {
      sleep: async () => {},
      now: () => 0,
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"company":"JSON 公司"}' } }] }), { status: 200 }),
    },
  );
  const result = await runWithDegradation<{ company: string }>({ hasCredential: true, adapter, messages, schema, rulesFallback });
  assert.equal(result.level, 'L1');
  assert.equal(result.path, 'prompt_json');
  assert.equal(result.status, 'ok');
  assert.equal(result.degraded, false);
});

test('L3：Key 失效（auth）→ 规则模式 + 更新 Key 的提示', async () => {
  const result = await runWithDegradation<{ company: string }>({
    hasCredential: true,
    adapter: throwingAdapter(ProviderError.auth(401)),
    messages,
    schema,
    rulesFallback,
  });
  assert.equal(result.level, 'L3');
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.data, { company: '规则模式公司' });
  assert.match(result.banner ?? '', /API Key 失效/);
  assert.equal(result.reasons[0]?.startsWith('auth'), true);
});

test('L3：上游不可达 → 规则模式 + 地址检查提示', async () => {
  const result = await runWithDegradation<{ company: string }>({
    hasCredential: true,
    adapter: throwingAdapter(ProviderError.unreachable(new Error('ECONNREFUSED'), 'http://127.0.0.1:11434/v1')),
    messages,
    schema,
    rulesFallback,
  });
  assert.equal(result.level, 'L3');
  assert.match(result.banner ?? '', /无法连接模型服务/);
});

test('L3：限流耗尽 → 规则模式 + 稍后重试提示', async () => {
  const result = await runWithDegradation<{ company: string }>({
    hasCredential: true,
    adapter: throwingAdapter(ProviderError.rateLimit(3000)),
    messages,
    schema,
    rulesFallback,
  });
  assert.equal(result.level, 'L3');
  assert.match(result.banner ?? '', /限流/);
});

test('L2（默认）：结构化输出失败 → 转 L3 规则模式，用户仍拿到可用结果', async () => {
  const result = await runWithDegradation<{ company: string }>({
    hasCredential: true,
    adapter: throwingAdapter(ProviderError.schema('not json', 3)),
    messages,
    schema,
    rulesFallback,
  });
  assert.equal(result.level, 'L3');
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.data, { company: '规则模式公司' });
  assert.match(result.banner ?? '', /未通过结构校验/);
});

test('L2（onSchemaError=throw）：直接失败，不静默降级', async () => {
  const result = await runWithDegradation<{ company: string }>({
    hasCredential: true,
    adapter: throwingAdapter(ProviderError.schema('not json', 3)),
    messages,
    schema,
    rulesFallback,
    onSchemaError: 'throw',
  });
  assert.equal(result.level, 'L2');
  assert.equal(result.status, 'failed');
  assert.equal(result.data, undefined);
  assert.ok(result.error instanceof ProviderError);
});

test('config 错误不降级：请求根本没发出去，必须暴露真实配置问题', async () => {
  const result = await runWithDegradation<{ company: string }>({
    hasCredential: true,
    adapter: throwingAdapter(ProviderError.config('出站请求被拒绝：域名 evil.example.com 不在白名单内')),
    messages,
    schema,
    rulesFallback,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.degraded, false);
  assert.equal(result.data, undefined, '不应用规则结果掩盖配置错误');
  assert.match(result.banner ?? '', /出站请求被拒绝/);
});

test('能力缺失（capability）→ L3 规则模式并说明缺哪项能力', async () => {
  const result = await runWithDegradation<{ company: string }>({
    hasCredential: true,
    adapter: throwingAdapter(ProviderError.capability('embedding')),
    messages,
    schema,
    rulesFallback,
  });
  assert.equal(result.level, 'L3');
  assert.match(result.banner ?? '', /embedding/);
});

test('纯文本对话路径（无 schema）也能返回结果', async () => {
  const adapter = createOpenAICompatibleAdapter(config, {
    sleep: async () => {},
    now: () => 0,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '你好，这是回复' } }] }), { status: 200 }),
  });
  const result = await runWithDegradation<string>({
    hasCredential: true,
    adapter,
    messages,
    rulesFallback: () => '（规则模式无文本输出）',
    task: 'generate',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.data, '你好，这是回复');
});

test('DegradationTracker：统计各层级与降级率', async () => {
  const tracker = new DegradationTracker();
  tracker.record({ level: 'L0', status: 'ok' });
  tracker.record({ level: 'L1', status: 'ok' });
  tracker.record({ level: 'L3', status: 'degraded' });
  tracker.record({ level: 'L4', status: 'degraded' });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.total, 4);
  assert.equal(snapshot.counts.L0, 1);
  assert.equal(snapshot.counts.L4, 1);
  assert.equal(snapshot.degradedRate, 0.5);
});

test('DegradationTracker：空统计不除零', () => {
  assert.equal(new DegradationTracker().snapshot().degradedRate, 0);
});
