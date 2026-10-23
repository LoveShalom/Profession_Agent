import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderError } from '../src/lib/errors.ts';
import { EgressGuard } from '../src/lib/llm/guard.ts';
import { createOpenAICompatibleAdapter, parseRetryAfter } from '../src/lib/llm/openai-compatible.ts';
import type { Capabilities, ProviderConfig, SchemaLike } from '../src/lib/llm/types.ts';

// ---------------------------------------------------------------- 测试夹具

const CAPS: Capabilities = {
  tool_calling: true,
  json_schema: false,
  stream: true,
  embedding: true,
  context_window: 32768,
  max_output: 4096,
  source: 'declared',
};

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-key-1234567890',
    model: 'deepseek-chat',
    timeoutMs: 50,
    maxRetries: 2,
    allowPrivateBaseUrl: false,
    capabilities: CAPS,
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** 造一个按顺序返回预设响应的 fetch 桩（每次交出 Response 的 clone，避免 body 只能读一次） */
function stubFetch(responses: Array<Response | Error | ((init: RequestInit | undefined) => Promise<Response>)>) {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(init);
    // 关键：保留原始 Response 不被消费，每次发一个 clone 出去
    return (next as Response).clone();
  };
  return { fetchImpl, calls, callCount: () => index };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

const chatOk = (content: string, extra: Record<string, unknown> = {}) =>
  jsonResponse({
    model: 'deepseek-chat',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
    ...extra,
  });

/** 简易 schema（与 zod 的接口对齐；不引入依赖） */
function objectSchema(fields: Record<string, 'string' | 'number' | 'null'>): SchemaLike<Record<string, unknown>> & {
  jsonSchema: Record<string, unknown>;
  describe(): string;
} {
  const validate = (input: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: string } => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { success: false, error: '应为对象' };
    }
    const record = input as Record<string, unknown>;
    for (const [key, type] of Object.entries(fields)) {
      const value = record[key];
      if (value === null) continue;
      if (type === 'number' && typeof value !== 'number') return { success: false, error: `字段 ${key} 应为数字` };
      if (type === 'string' && typeof value !== 'string') return { success: false, error: `字段 ${key} 应为字符串` };
    }
    return { success: true, data: record };
  };
  return {
    jsonSchema: { type: 'object', properties: Object.fromEntries(Object.keys(fields).map((k) => [k, { type: fields[k] === 'null' ? 'string' : fields[k] }])) },
    describe: () => `字段：${Object.keys(fields).join(', ')}`,
    parse: (input) => {
      const result = validate(input);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    safeParse: validate,
  };
}

const messages = [{ role: 'user' as const, content: '这是一段 JD 文本' }];
const sleepLog: number[] = [];
const instantSleep = async (ms: number) => {
  sleepLog.push(ms);
};
function deps(fetchImpl: ReturnType<typeof stubFetch>['fetchImpl'], guard?: EgressGuard) {
  sleepLog.length = 0;
  return { fetchImpl, sleep: instantSleep, now: () => 0, guard };
}

// ---------------------------------------------------------------- 基础对话

test('chat：成功解析文本与 token 用量', async () => {
  const stub = stubFetch([chatOk('你好')]);
  const usage: unknown[] = [];
  const adapter = createOpenAICompatibleAdapter(config(), { ...deps(stub.fetchImpl), onUsage: (u) => usage.push(u) });

  const result = await adapter.chat(messages, { task: 'generate' });
  assert.equal(result.text, '你好');
  assert.equal(result.usage.promptTokens, 120);
  assert.equal(result.usage.completionTokens, 30);
  assert.equal(result.usage.model, 'deepseek-chat');
  assert.equal(stub.calls[0]!.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(usage.length, 1);
});

test('chat：401 立即失败，不重试（AC-4）', async () => {
  const stub = stubFetch([textResponse('{"error":"invalid api key"}', 401)]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  await assert.rejects(
    () => adapter.chat(messages),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'auth');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(stub.callCount(), 1, '不应重试');
  assert.equal(sleepLog.length, 0);
});

test('chat：429 读取 Retry-After 后退避重试并最终成功', async () => {
  const stub = stubFetch([textResponse('rate limited', 429, { 'retry-after': '2' }), chatOk('重试成功')]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  const result = await adapter.chat(messages);
  assert.equal(result.text, '重试成功');
  assert.equal(stub.callCount(), 2);
  assert.deepEqual(sleepLog, [2000]);
  assert.equal(result.usage.attempts, 2);
});

test('chat：5xx 重试耗尽后抛 server 错误（可降级）', async () => {
  const stub = stubFetch([textResponse('boom', 503)]);
  const adapter = createOpenAICompatibleAdapter(config({ maxRetries: 1 }), deps(stub.fetchImpl));
  await assert.rejects(
    () => adapter.chat(messages),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'server');
      assert.equal(error.shouldDegrade, true);
      return true;
    },
  );
  assert.equal(stub.callCount(), 2, 'maxRetries=1 时应请求 2 次');
});

test('chat：网络异常 → unreachable，提示检查地址与私网开关（AC-5）', async () => {
  const stub = stubFetch([new Error('ECONNREFUSED')]);
  const adapter = createOpenAICompatibleAdapter(config({ maxRetries: 0 }), deps(stub.fetchImpl));
  await assert.rejects(
    () => adapter.chat(messages),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'unreachable');
      assert.match(error.userHint, /LLM_BASE_URL/);
      return true;
    },
  );
});

test('chat：404 → config 错误并提示检查模型名', async () => {
  const stub = stubFetch([textResponse('model not found', 404)]);
  const adapter = createOpenAICompatibleAdapter(config({ maxRetries: 0 }), deps(stub.fetchImpl));
  await assert.rejects(
    () => adapter.chat(messages),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'config');
      assert.match(error.message, /deepseek-chat/);
      return true;
    },
  );
});

test('chat：超时（AbortController）→ unreachable', async () => {
  const hanging = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
    });
  const adapter = createOpenAICompatibleAdapter(
    config({ timeoutMs: 10, maxRetries: 0 }),
    { fetchImpl: hanging, sleep: instantSleep, now: () => 0 },
  );
  await assert.rejects(() => adapter.chat(messages), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'unreachable');
    return true;
  });
});

// ---------------------------------------------------------------- 结构化输出

test('chatJSON：优先走 tool calling，并从 arguments 解析结果（L0）', async () => {
  const stub = stubFetch([
    jsonResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ function: { name: 'emit_result', arguments: '{"company":"示例科技","salary_min":20000}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 40 },
    }),
  ]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  const schema = objectSchema({ company: 'string', salary_min: 'number' });
  const { data, result } = await adapter.chatJSON(messages, schema, { task: 'extract' });

  assert.equal(data['company'], '示例科技');
  assert.equal(data['salary_min'], 20000);
  assert.equal(result.path, 'tool_calling');
  const body = stub.calls[0]!.body!;
  assert.equal(Array.isArray(body['tools']), true);
  assert.ok(body['tool_choice']);
});

test('chatJSON：上游不支持 tools 时自动降级到 Prompt-JSON 并记住该能力（L1）', async () => {
  const stub = stubFetch([
    textResponse('{"error":"tools is not supported by this model"}', 400),
    chatOk('{"company":"降级科技"}'),
  ]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  const schema = objectSchema({ company: 'string' });

  const { data, result } = await adapter.chatJSON(messages, schema);
  assert.equal(data['company'], '降级科技');
  assert.equal(result.path, 'prompt_json');
  assert.equal(stub.callCount(), 2);
  // 能力自学习：tool_calling 被标记为不可用
  assert.equal(adapter.capabilities().tool_calling, false);
  assert.equal(adapter.capabilities().source, 'probe');
});

test('chatJSON（Prompt-JSON）：容忍 ```json 代码块围栏与前后噪声', async () => {
  const stub = stubFetch([chatOk('这是结果：\n```json\n{"company":"围栏科技"}\n```\n以上')]);
  const adapter = createOpenAICompatibleAdapter(config({ capabilities: { ...CAPS, tool_calling: false } }), deps(stub.fetchImpl));
  const { data, result } = await adapter.chatJSON(messages, objectSchema({ company: 'string' }));
  assert.equal(data['company'], '围栏科技');
  assert.equal(result.path, 'prompt_json');
});

test('chatJSON：结构不合规时带入错误信息修复重试并成功', async () => {
  const stub = stubFetch([chatOk('{"company":123}'), chatOk('{"company":"修正科技"}')]);
  const adapter = createOpenAICompatibleAdapter(config({ capabilities: { ...CAPS, tool_calling: false } }), deps(stub.fetchImpl));
  const { data } = await adapter.chatJSON(messages, objectSchema({ company: 'string' }));
  assert.equal(data['company'], '修正科技');
  assert.equal(stub.callCount(), 2);
  // 第二次请求应包含纠正指令
  const secondMessages = stub.calls[1]!.body!['messages'] as Array<{ role: string; content: string }>;
  assert.ok(secondMessages.some((m) => m.content.includes('未通过结构校验')));
});

test('chatJSON：修复重试耗尽后抛 schema 错误（L2），原始输出已脱敏', async () => {
  const stub = stubFetch([chatOk('not json at all sk-abcdef1234567890')]);
  const adapter = createOpenAICompatibleAdapter(config({ capabilities: { ...CAPS, tool_calling: false } }), deps(stub.fetchImpl));
  await assert.rejects(
    () => adapter.chatJSON(messages, objectSchema({ company: 'string' })),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'schema');
      assert.ok((error.attempts ?? 0) >= 3, '初次 + 2 次修复');
      assert.equal(error.raw?.includes('sk-abcdef1234567890'), false);
      return true;
    },
  );
  assert.equal(stub.callCount(), 3);
});

test('chatJSON：useTools=false 时不发送 tools 字段（forcePromptJson）', async () => {
  const stub = stubFetch([chatOk('{"company":"强制"}')]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  await adapter.chatJSON(messages, objectSchema({ company: 'string' }), { forcePromptJson: true });
  assert.equal(stub.calls[0]!.body!['tools'], undefined);
});

// ---------------------------------------------------------------- Embedding / probe / 白名单

test('embed：未声明 embedding 能力时抛 capability 错误（触发 tsvector 降级）', async () => {
  const stub = stubFetch([jsonResponse({ data: [] })]);
  const adapter = createOpenAICompatibleAdapter(config({ capabilities: { ...CAPS, embedding: false } }), deps(stub.fetchImpl));
  await assert.rejects(() => adapter.embed(['文本']), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'capability');
    assert.equal(error.missing, 'embedding');
    return true;
  });
  assert.equal(stub.callCount(), 0, '不应发起请求');
});

test('embed：返回向量数组', async () => {
  const stub = stubFetch([jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 5 } })]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  const vectors = await adapter.embed(['文本']);
  assert.deepEqual(vectors, [[0.1, 0.2, 0.3]]);
});

test('probe：GET /models 成功 → ok（用于保存凭证时的冒烟校验）', async () => {
  const stub = stubFetch([jsonResponse({ data: [{ id: 'deepseek-chat' }] })]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  const result = await adapter.probe();
  assert.equal(result.ok, true);
  assert.equal(stub.calls[0]!.method, 'GET');
  assert.match(stub.calls[0]!.url, /\/models$/);
});

test('probe：401 → ok=false（保存阶段应拒绝写入凭证，AC-4）', async () => {
  const stub = stubFetch([textResponse('unauthorized', 401)]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  const result = await adapter.probe();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /API Key/);
});

test('probe：网关没有 /models 时回退到 1 token 最小对话', async () => {
  const stub = stubFetch([textResponse('not found', 404), chatOk('pong')]);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl));
  const result = await adapter.probe();
  assert.equal(result.ok, true);
  assert.equal(stub.callCount(), 2);
  assert.equal(stub.calls[1]!.body!['max_tokens'], 1);
});

test('probe：不可达 → ok=false 且给出地址检查建议（AC-5）', async () => {
  const stub = stubFetch([new Error('ENOTFOUND')]);
  const adapter = createOpenAICompatibleAdapter(config({ maxRetries: 0 }), deps(stub.fetchImpl));
  const result = await adapter.probe();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /LLM_BASE_URL/);
});

test('出站白名单（AC-10）：未授权域名在发请求前就被拒绝', async () => {
  const stub = stubFetch([chatOk('不应到达')]);
  const guard = new EgressGuard(['api.openai.com']);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl, guard));
  await assert.rejects(() => adapter.chat(messages), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.kind, 'config');
    return true;
  });
  assert.equal(stub.callCount(), 0, '被拦截的请求不应发出');
  assert.equal(guard.blockedAttempts().length, 1);
});

test('出站白名单：授权域名正常放行', async () => {
  const stub = stubFetch([chatOk('ok')]);
  const guard = new EgressGuard(['api.deepseek.com']);
  const adapter = createOpenAICompatibleAdapter(config(), deps(stub.fetchImpl, guard));
  const result = await adapter.chat(messages);
  assert.equal(result.text, 'ok');
  assert.equal(guard.blockedAttempts().length, 0);
});

test('parseRetryAfter：支持秒数与 HTTP 日期', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('not-a-number'), undefined);
  const future = new Date(Date.now() + 5000).toUTCString();
  const parsed = parseRetryAfter(future);
  assert.ok(parsed !== undefined && parsed > 3000 && parsed <= 6000);
});

test('适配层不持有明文密钥以外的状态：capabilities 返回副本', () => {
  const adapter = createOpenAICompatibleAdapter(config(), {});
  const caps = adapter.capabilities();
  caps.tool_calling = false;
  assert.equal(adapter.capabilities().tool_calling, true, 'capabilities 必须是副本，避免外部篡改');
});
