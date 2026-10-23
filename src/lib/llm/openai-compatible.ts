/**
 * OpenAI 兼容 Provider 适配器（I0 / T4、T5）
 *
 * 覆盖范围：DeepSeek / Qwen（百炼兼容模式）/ Kimi / GLM / SiliconFlow / OpenAI / Ollama
 * 以及任意自定义网关（one-api / new-api / OpenRouter …），全部走同一套 `/chat/completions`
 * 与 `/embeddings` 协议。**零运行时依赖**（只用全局 fetch），因此可在无网络环境下用桩测试。
 *
 * 关键行为：
 * - 错误分类：401/403→auth、429→rate_limit（读 Retry-After）、5xx→server、网络/超时→unreachable、400/404/422→config
 * - 重试：对 retryable 错误指数退避（可注入 sleep），尊重 Retry-After
 * - 结构化输出双路径：tool calling（优先）→ Prompt-JSON + 校验 + 修复重试 ≤2
 * - 能力自学习：tool calling 请求被上游明确拒绝时，就地降级并把 capabilities.tool_calling 标记为 false
 * - 出站白名单：请求前经 guard 校验（T6）
 */

import { ProviderError } from '../errors.ts';
import type {
  AdapterDeps,
  Capabilities,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ProbeResult,
  ProviderAdapter,
  ProviderConfig,
  SchemaLike,
  TaskName,
  UsageRecord,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 400;
const MAX_REPAIR_ATTEMPTS = 2;

interface ResolvedDeps {
  fetchImpl: NonNullable<AdapterDeps['fetchImpl']>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  guard: AdapterDeps['guard'];
  onUsage: AdapterDeps['onUsage'];
  logger: Required<Pick<NonNullable<AdapterDeps['logger']>, 'debug' | 'warn'>>;
}

function resolveDeps(deps: AdapterDeps = {}): ResolvedDeps {
  const noop = () => {};
  return {
    fetchImpl:
      deps.fetchImpl ??
      ((input, init) => {
        const f = globalThis.fetch;
        if (typeof f !== 'function') {
          throw ProviderError.unreachable(new Error('当前运行环境没有 fetch 实现'), String(input));
        }
        return f(input, init);
      }),
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => Date.now()),
    guard: deps.guard,
    onUsage: deps.onUsage,
    logger: {
      debug: deps.logger?.debug ?? noop,
      warn: deps.logger?.warn ?? noop,
    },
  };
}

/** 从 Retry-After 头解析等待毫秒数（支持秒数与 HTTP 日期两种形式） */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function classifyHttpError(status: number, bodyText: string, model: string): ProviderError {
  if (status === 401 || status === 403) return ProviderError.auth(status);
  if (status === 429) return ProviderError.rateLimit(undefined);
  if (status >= 500) return ProviderError.server(status, bodyText);
  if (status === 404) {
    return ProviderError.config(`上游返回 404（路径或模型不存在）：model=${model}`, '请检查 LLM_MODEL 与 LLM_BASE_URL 是否匹配该服务商。');
  }
  return ProviderError.config(`上游返回 ${status}：${bodyText.slice(0, 200)}`, '请检查请求参数与模型名是否正确。');
}

/** 上游是否在抱怨"不支持 tools / function calling"（用于能力自学习降级） */
function looksLikeToolsUnsupported(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes('tool') || lower.includes('function')) &&
    (lower.includes('not support') || lower.includes('unsupported') || lower.includes('invalid') || lower.includes('unknown'))
  );
}

export function createOpenAICompatibleAdapter(config: ProviderConfig, deps: AdapterDeps = {}): ProviderAdapter {
  const d = resolveDeps(deps);
  const timeoutMs = config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxRetries = Number.isInteger(config.maxRetries) ? config.maxRetries : DEFAULT_MAX_RETRIES;

  /** 能力表：探测/自学习会就地修正（source 随之变化） */
  let caps: Capabilities = config.capabilities
    ? { ...config.capabilities }
    : {
        tool_calling: false,
        json_schema: false,
        stream: true,
        embedding: false,
        context_window: 0,
        max_output: 0,
        source: 'default',
      };

  function endpoint(path: string): string {
    return `${config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  function headers(): Record<string, string> {
    const result: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (config.apiKey) result['authorization'] = `Bearer ${config.apiKey}`;
    for (const [k, v] of Object.entries(config.extraHeaders ?? {})) result[k.toLowerCase()] = v;
    return result;
  }

  async function rawFetch(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    d.guard?.assertAllowed(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await d.fetchImpl(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw ProviderError.unreachable(error, config.baseUrl);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 带重试的请求：返回解析后的 JSON */
  async function requestJson(
    url: string,
    body: unknown,
    task: TaskName,
    signal?: AbortSignal,
  ): Promise<{ json: Record<string, unknown>; latencyMs: number; attempts: number }> {
    let attempt = 0;
    let lastError: ProviderError | undefined;
    while (attempt <= maxRetries) {
      attempt += 1;
      const startedAt = d.now();
      try {
        const response = await rawFetch(url, body, signal);
        const latencyMs = d.now() - startedAt;
        if (!response.ok) {
          const text = await safeText(response);
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          let error = classifyHttpError(response.status, text, config.model);
          if (error.kind === 'rate_limit' && retryAfterMs !== undefined) {
            error = ProviderError.rateLimit(retryAfterMs);
          }
          if (error.kind === 'config' && looksLikeToolsUnsupported(text)) {
            error = new ProviderError('config', `上游不支持该请求形态：${text.slice(0, 200)}`, {
              status: response.status,
            });
          }
          throw error;
        }
        const json = (await response.json()) as Record<string, unknown>;
        return { json, latencyMs, attempts: attempt };
      } catch (error) {
        const providerError = error instanceof ProviderError ? error : ProviderError.unreachable(error, config.baseUrl);
        lastError = providerError;
        if (!providerError.retryable || attempt > maxRetries) throw providerError;
        const wait = providerError.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
        d.logger.warn('provider 调用失败，准备重试', {
          kind: providerError.kind,
          attempt,
          waitMs: wait,
          task,
        });
        await d.sleep(wait);
      }
    }
    throw lastError ?? ProviderError.unreachable(new Error('未知失败'), config.baseUrl);
  }

  function readUsage(json: Record<string, unknown>, latencyMs: number, task: TaskName, attempts: number, degraded: boolean): UsageRecord {
    const usage = (json['usage'] ?? {}) as Record<string, unknown>;
    const model = typeof json['model'] === 'string' ? (json['model'] as string) : config.model;
    return {
      provider: config.provider,
      model,
      task,
      promptTokens: Number(usage['prompt_tokens'] ?? 0),
      completionTokens: Number(usage['completion_tokens'] ?? 0),
      latencyMs,
      cacheHit: false,
      degraded,
      attempts,
    };
  }

  function firstChoiceMessage(json: Record<string, unknown>): Record<string, unknown> {
    const choices = json['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw ProviderError.config('上游返回中没有 choices 字段', '该端点可能不是 OpenAI 兼容接口。');
    }
    const first = choices[0] as Record<string, unknown>;
    return (first['message'] ?? {}) as Record<string, unknown>;
  }

  function messageText(json: Record<string, unknown>): string {
    const content = firstChoiceMessage(json)['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text: unknown }).text) : ''))
        .join('');
    }
    return '';
  }

  function toolArguments(json: Record<string, unknown>): string | undefined {
    const message = firstChoiceMessage(json);
    const calls = message['tool_calls'];
    if (!Array.isArray(calls) || calls.length === 0) return undefined;
    const fn = (calls[0] as Record<string, unknown>)['function'];
    if (typeof fn !== 'object' || fn === null) return undefined;
    const args = (fn as Record<string, unknown>)['arguments'];
    return typeof args === 'string' ? args : JSON.stringify(args ?? {});
  }

  /** 解析 JSON 文本，容忍 ```json 围栏与前后噪声 */
  function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    const candidates = [cleaned];
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
    for (const candidate of candidates) {
      try {
        return { ok: true, value: JSON.parse(candidate) };
      } catch {
        /* 继续尝试 */
      }
    }
    return { ok: false, reason: '返回内容不是合法 JSON' };
  }

  async function probe(): Promise<ProbeResult> {
    const startedAt = d.now();
    const url = endpoint('/models');
    try {
      d.guard?.assertAllowed(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await d.fetchImpl(url, { method: 'GET', headers: headers(), signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, latencyMs: d.now() - startedAt, capabilities: caps, detail: ProviderError.auth(response.status).userHint };
      }
      if (response.ok) {
        return { ok: true, latencyMs: d.now() - startedAt, capabilities: caps, model: config.model };
      }
      // 部分网关没有 /models 或需要 POST 探测 → 用 1 token 的最小对话兜底
      const fallback = await requestJson(
        endpoint('/chat/completions'),
        { model: config.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
        'probe',
      );
      return {
        ok: true,
        latencyMs: d.now() - startedAt,
        capabilities: caps,
        model: typeof fallback.json['model'] === 'string' ? (fallback.json['model'] as string) : config.model,
      };
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : ProviderError.unreachable(error, config.baseUrl);
      return { ok: false, latencyMs: d.now() - startedAt, capabilities: caps, detail: providerError.userHint };
    }
  }

  async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const task: TaskName = opts.task ?? config.task ?? 'generate';
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.maxTokens) body['max_tokens'] = opts.maxTokens;

    const { json, latencyMs, attempts } = await requestJson(endpoint('/chat/completions'), body, task, opts.signal);
    const usage = readUsage(json, latencyMs, task, attempts, false);
    d.onUsage?.(usage);
    return { text: messageText(json), usage, path: 'prompt_json' };
  }

  /**
   * 结构化输出：优先 tool calling，失败则 Prompt-JSON + 校验 + 修复重试。
   * 这是降级链在适配层内部的体现（L0 → L1），跨 provider 行为一致。
   */
  async function chatJSON<T>(
    messages: ChatMessage[],
    schema: SchemaLike<T>,
    opts: ChatOptions = {},
  ): Promise<{ data: T; result: ChatResult }> {
    const task: TaskName = opts.task ?? config.task ?? 'extract';
    const useTools = Boolean(!opts.forcePromptJson && caps.tool_calling && schema.jsonSchema);

    if (useTools) {
      try {
        return await callWithTools<T>(messages, schema, task, opts);
      } catch (error) {
        const providerError = error instanceof ProviderError ? error : ProviderError.unreachable(error, config.baseUrl);
        const unsupported =
          providerError.kind === 'config' && /tools|function/i.test(providerError.message);
        if (!unsupported) throw providerError;
        // 能力自学习：把 tool_calling 标记为不可用，后续请求直接走 Prompt-JSON
        caps = { ...caps, tool_calling: false, source: 'probe' };
        d.logger.warn('上游不支持 tool calling，已切换 Prompt-JSON 路径', { provider: config.provider, model: config.model });
      }
    }

    return callWithPromptJson<T>(messages, schema, task, opts);
  }

  async function callWithTools<T>(
    messages: ChatMessage[],
    schema: SchemaLike<T>,
    task: TaskName,
    opts: ChatOptions,
  ): Promise<{ data: T; result: ChatResult }> {
    const toolName = 'emit_result';
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: opts.temperature ?? 0.1,
      tools: [
        {
          type: 'function',
          function: {
            name: toolName,
            description: schema.describe?.() ?? '返回结构化结果',
            parameters: schema.jsonSchema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: toolName } },
    };

    const { json, latencyMs, attempts } = await requestJson(endpoint('/chat/completions'), body, task, opts.signal);
    const rawArgs = toolArguments(json);
    const usage = readUsage(json, latencyMs, task, attempts, false);
    d.onUsage?.(usage);

    if (rawArgs === undefined) {
      throw ProviderError.schema(JSON.stringify(firstChoiceMessage(json)).slice(0, 500), attempts);
    }
    const parsed = schema.safeParse(safeJsonParse(rawArgs));
    if (!parsed.success) throw ProviderError.schema(rawArgs, attempts);

    return {
      data: parsed.data,
      result: { text: rawArgs, usage, path: 'tool_calling' },
    };
  }

  async function callWithPromptJson<T>(
    messages: ChatMessage[],
    schema: SchemaLike<T>,
    task: TaskName,
    opts: ChatOptions,
  ): Promise<{ data: T; result: ChatResult }> {
    const instruction = buildJsonInstruction(schema);
    const conversation: ChatMessage[] = [...messages, { role: 'system', content: instruction }];
    let lastRaw = '';
    let attemptsTotal = 0;

    for (let repair = 0; repair <= MAX_REPAIR_ATTEMPTS; repair += 1) {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: conversation,
        temperature: repair === 0 ? (opts.temperature ?? 0.1) : 0,
      };
      if (opts.maxTokens) body['max_tokens'] = opts.maxTokens;
      if (caps.json_schema && schema.jsonSchema) {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: { name: 'result', strict: true, schema: schema.jsonSchema },
        };
      }

      const { json, latencyMs, attempts } = await requestJson(endpoint('/chat/completions'), body, task, opts.signal);
      attemptsTotal += attempts;
      const usage = readUsage(json, latencyMs, task, attemptsTotal, repair > 0);
      d.onUsage?.(usage);
      const text = messageText(json);
      lastRaw = text;

      const parsedText = tryParseJson(text);
      if (!parsedText.ok) {
        conversation.push({ role: 'assistant', content: text });
        conversation.push({ role: 'user', content: `上一条输出无法解析为 JSON（${parsedText.reason}）。请只输出一个合法 JSON 对象，不要包含解释或 Markdown 代码块。` });
        continue;
      }
      const validated = schema.safeParse(parsedText.value);
      if (validated.success) {
        return { data: validated.data, result: { text, usage, path: 'prompt_json' } };
      }
      conversation.push({ role: 'assistant', content: text });
      conversation.push({
        role: 'user',
        content: `上一条输出未通过结构校验：${validated.error}\n请修正后重新只输出一个合法 JSON 对象。`,
      });
    }

    throw ProviderError.schema(lastRaw, attemptsTotal);
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (!caps.embedding) throw ProviderError.capability('embedding');
    const body = { model: config.model, input: texts };
    const { json, latencyMs, attempts } = await requestJson(endpoint('/embeddings'), body, 'embed');
    d.onUsage?.(readUsage(json, latencyMs, 'embed', attempts, false));
    const data = json['data'];
    if (!Array.isArray(data)) throw ProviderError.config('embeddings 响应缺少 data 字段');
    return data.map((item) => {
      const embedding = (item as Record<string, unknown>)['embedding'];
      if (!Array.isArray(embedding)) throw ProviderError.config('embeddings 元素缺少 embedding 字段');
      return embedding.map((n) => Number(n));
    });
  }

  return {
    config,
    capabilities: () => ({ ...caps }),
    probe,
    chat,
    chatJSON,
    embed,
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __unparsable: text.slice(0, 200) };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/** 组装 Prompt-JSON 的指令（含 schema 描述，便于模型自校验） */
function buildJsonInstruction<T>(schema: SchemaLike<T>): string {
  const description = schema.describe?.();
  const jsonSchema = schema.jsonSchema ? JSON.stringify(schema.jsonSchema) : '';
  return [
    '你是结构化信息抽取器。',
    '只输出一个 JSON 对象，不要输出解释、前后缀或 Markdown 代码块。',
    '无法确定的字段用 null，且必须保留字段名，不要新增或删除字段。',
    description ? `字段说明：${description}` : '',
    jsonSchema ? `JSON Schema：${jsonSchema}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
