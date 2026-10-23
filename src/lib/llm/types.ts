/**
 * Provider 适配层契约（I0 / T4）
 *
 * 设计原则（F-01 §1.2-C）：
 * - 业务代码只依赖本文件的接口，**不出现任何厂商名**；
 * - 所有能力/错误都是可判别的数据，而不是字符串约定，降级链与 doctor 才能据此分流；
 * - 全部依赖通过 deps 注入（fetch / sleep / now / logger），因此**无需网络即可完整测试**。
 */

import type { CapabilityName, ProviderError } from '../errors.ts';

/** 任务类型：用于任务级模型偏好与用量归因 */
export type TaskName = 'extract' | 'generate' | 'embed' | 'rerank' | 'probe';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Capabilities {
  tool_calling: boolean;
  json_schema: boolean;
  stream: boolean;
  embedding: boolean;
  /** 上下文窗口（token），未知时为 0 */
  context_window: number;
  /** 单次最大输出（token），未知时为 0 */
  max_output: number;
  /** 能力来源：探测得到 / 配置声明 / 内置默认表 */
  source: 'probe' | 'declared' | 'default';
}

/** 对 Zod 等校验库的最小抽象（零依赖；zod schema 天然满足） */
export interface SchemaLike<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: string };
  /** 可选：传给 provider 的 JSON Schema（用于 json_schema / tool calling） */
  jsonSchema?: Record<string, unknown>;
  /** 可选：给模型看的结构说明（走 Prompt-JSON 降级路径时用） */
  describe?(): string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  capabilities: Capabilities;
  /** 探测时实际使用的模型名（provider 可能回填真实版本） */
  model?: string;
  detail?: string;
}

export interface ProviderConfig {
  /** 预设名或 'custom' */
  provider: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 任务级模型偏好解析结果 */
  task?: TaskName;
  timeoutMs: number;
  maxRetries: number;
  /** 是否允许私网地址（Ollama / vLLM） */
  allowPrivateBaseUrl: boolean;
  /** 能力：来自缓存/声明；缺失时由 probe 填充 */
  capabilities?: Capabilities;
  /** 额外的请求头（中转站可能需要） */
  extraHeaders?: Record<string, string>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AdapterDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: Logger;
  /** 出站白名单守卫（T6）；传入后每次请求前校验目标域名 */
  guard?: { assertAllowed(url: string): void };
  /** 每次成功/失败调用后的回调（写 llm_usage_logs 用；degraded 标记降级） */
  onUsage?: (record: UsageRecord) => void;
}

export interface UsageRecord {
  provider: string;
  model: string;
  task: TaskName;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  cacheHit: boolean;
  degraded: boolean;
  attempts: number;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  task?: TaskName;
  signal?: AbortSignal;
  /** 强制走 Prompt-JSON（跳过 tool calling），降级链用 */
  forcePromptJson?: boolean;
}

export interface ChatResult {
  text: string;
  usage: UsageRecord;
  /** 实际走的路径：tool_calling / prompt_json */
  path: 'tool_calling' | 'prompt_json';
}

export interface ProviderAdapter {
  readonly config: ProviderConfig;
  capabilities(): Capabilities;
  probe(): Promise<ProbeResult>;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  chatJSON<T>(messages: ChatMessage[], schema: SchemaLike<T>, opts?: ChatOptions): Promise<{ data: T; result: ChatResult }>;
  embed(texts: string[]): Promise<number[][]>;
}

/** 无模型可用（L3/L4）时抛出的标记性错误 */
export class NoCredentialError extends Error {
  constructor() {
    super('未配置模型 API Key：已进入规则模式（L4）');
    this.name = 'NoCredentialError';
  }
}

export type { CapabilityName, ProviderError };
