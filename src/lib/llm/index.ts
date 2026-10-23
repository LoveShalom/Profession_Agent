/**
 * Provider 适配层统一入口（I0 / T4、T5、T6 的组装点）
 *
 * 业务代码只通过 `createLLM(env)` 拿服务，不接触任何厂商细节。这里负责把
 * 环境变量 → provider 配置 → 安全守卫 → 适配器 → 能力缓存 → 降级链 串起来。
 *
 * 为什么要有这一层：F-01 的 AC-3（换模型只改 .env）与 AC-13（业务零处厂商 SDK）
 * 都靠"唯一组装点"来保证——所有 provider 相关决策都收敛在本文件与 registry.ts。
 */

import { ProviderError } from '../errors.ts';
import type { Env } from '../env.ts';
import { capabilitiesFromPreset, createMemoryCapabilitiesStore, describeCapabilities, mergeCapabilities, resolveCapabilities } from './capabilities.ts';
import type { CapabilitiesStore } from './capabilities.ts';
import { DegradationTracker, runWithDegradation } from './degrade.ts';
import type { DegradationResult } from './degrade.ts';
import { EgressGuard, assertBaseUrlAllowed } from './guard.ts';
import { createOpenAICompatibleAdapter } from './openai-compatible.ts';
import { allowedEgressHosts, resolveProvider, resolveTaskModel } from './registry.ts';
import type { ProviderPreset, ResolvedProvider } from './registry.ts';
import type {
  AdapterDeps,
  Capabilities,
  ChatMessage,
  ChatOptions,
  ProbeResult,
  ProviderAdapter,
  ProviderConfig,
  SchemaLike,
  TaskName,
} from './types.ts';

export interface CreateLLMOptions extends AdapterDeps {
  /** 能力缓存（默认内存实现；接 DB 时注入即可） */
  store?: CapabilitiesStore;
  /** 跳过探测（doctor --no-network / 离线环境） */
  skipProbe?: boolean;
  /** 每次探测后回调（用于写 user_llm_credentials.capabilities） */
  onCapabilities?: (provider: string, model: string, capabilities: Capabilities) => void;
}

export interface ServiceStatus {
  provider: string;
  providerLabel: string;
  model: string;
  baseUrl: string;
  hasCredential: boolean;
  keyOptional: boolean;
  allowPrivateBaseUrl: boolean;
  egressHosts: readonly string[];
  capabilities: Capabilities;
  capabilitiesText: string;
  lastProbe?: ProbeResult;
  degradation: ReturnType<DegradationTracker['snapshot']>;
}

export interface LLMService {
  readonly provider: ResolvedProvider;
  readonly preset: ProviderPreset;
  readonly hasCredential: boolean;
  readonly egressGuard: EgressGuard;
  readonly tracker: DegradationTracker;
  /** 同步返回当前已知能力（未探测时为预设/声明值） */
  capabilities(): Capabilities;
  /** 主动探测并刷新能力缓存（设置页保存凭证、doctor 使用） */
  probe(): Promise<ProbeResult>;
  status(): ServiceStatus;
  /** 统一的执行入口：自动走 L0–L4 */
  run<T>(params: {
    messages: ChatMessage[];
    schema?: SchemaLike<T>;
    rulesFallback: () => T;
    task?: TaskName;
    opts?: ChatOptions;
    onSchemaError?: 'degrade' | 'throw';
  }): Promise<DegradationResult<T>>;
}

export function createLLM(env: Env, options: CreateLLMOptions = {}): LLMService {
  const now = options.now ?? (() => Date.now());
  const store = options.store ?? createMemoryCapabilitiesStore();

  // 1) 解析 provider（未知 provider / custom 缺参数在此抛 config 错误）
  const provider = resolveProvider({
    provider: env.llmProvider,
    baseUrl: env.llmBaseUrl,
    model: env.llmModel,
    allowPrivateBaseUrl: env.allowPrivateBaseUrl,
  });
  const preset = provider.preset;

  // 2) 私网保护（AC-8）：不通过直接抛 config，提示如何开启
  assertBaseUrlAllowed(provider.baseUrl, { allowPrivate: env.allowPrivateBaseUrl });

  // 3) 出站白名单（AC-10）：只放行用户配置的 provider 域名
  const egressHosts = allowedEgressHosts({
    providerBaseUrl: provider.baseUrl,
    extraHosts: env.egressExtraHosts,
    telemetryHost: env.langfuseHost,
  });
  const egressGuard = new EgressGuard(egressHosts, now);

  // 4) 能力：预设默认 → 允许配置声明覆盖
  const fallbackCapabilities = capabilitiesFromPreset(preset);

  // 5) 凭证：Ollama 等本地模型允许无 Key
  const hasCredential = Boolean(env.llmApiKey && env.llmApiKey.trim() !== '') || Boolean(preset.keyOptional);

  const config: ProviderConfig = {
    provider: preset.name,
    baseUrl: provider.baseUrl,
    ...(env.llmApiKey ? { apiKey: env.llmApiKey } : {}),
    model: provider.model,
    timeoutMs: 30_000,
    maxRetries: 2,
    allowPrivateBaseUrl: env.allowPrivateBaseUrl,
    capabilities: fallbackCapabilities,
  };

  const deps: AdapterDeps = {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    guard: egressGuard,
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
  };

  const adapter: ProviderAdapter | undefined = hasCredential
    ? createOpenAICompatibleAdapter(config, deps)
    : undefined;

  let currentCapabilities: Capabilities = fallbackCapabilities;
  let lastProbe: ProbeResult | undefined;
  let capabilitiesPromise: Promise<Capabilities> | undefined;

  async function ensureCapabilities(): Promise<Capabilities> {
    if (!adapter) return currentCapabilities;
    if (!capabilitiesPromise) {
      capabilitiesPromise = resolveCapabilities({
        adapter,
        store,
        provider: preset.name,
        model: provider.model,
        fallback: currentCapabilities,
        now,
        ...(options.skipProbe ? { skipProbe: true } : {}),
      }).then((result) => {
        currentCapabilities = result.capabilities;
        options.onCapabilities?.(preset.name, provider.model, result.capabilities);
        return result.capabilities;
      });
    }
    return capabilitiesPromise;
  }

  const tracker = new DegradationTracker();

  return {
    provider,
    preset,
    hasCredential,
    egressGuard,
    tracker,
    capabilities: () => ({ ...currentCapabilities }),
    async probe() {
      if (!adapter) {
        return {
          ok: false,
          latencyMs: 0,
          capabilities: currentCapabilities,
          detail: '未配置模型凭证：当前为规则模式（L4）。',
        } satisfies ProbeResult;
      }
      const result = await adapter.probe();
      lastProbe = result;
      if (result.ok) {
        currentCapabilities = mergeCapabilities({ ...currentCapabilities, ...result.capabilities }, { source: 'probe' });
        store.set({ provider: preset.name, model: provider.model, capabilities: currentCapabilities, probedAt: now() });
        capabilitiesPromise = Promise.resolve(currentCapabilities);
        options.onCapabilities?.(preset.name, provider.model, currentCapabilities);
      }
      return result;
    },
    status(): ServiceStatus {
      return {
        provider: preset.name,
        providerLabel: preset.label,
        model: provider.model,
        baseUrl: provider.baseUrl,
        hasCredential,
        keyOptional: Boolean(preset.keyOptional),
        allowPrivateBaseUrl: env.allowPrivateBaseUrl,
        egressHosts,
        capabilities: { ...currentCapabilities },
        capabilitiesText: describeCapabilities(currentCapabilities),
        ...(lastProbe ? { lastProbe } : {}),
        degradation: tracker.snapshot(),
      };
    },
    async run<T>(params: {
      messages: ChatMessage[];
      schema?: SchemaLike<T>;
      rulesFallback: () => T;
      task?: TaskName;
      opts?: ChatOptions;
      onSchemaError?: 'degrade' | 'throw';
    }): Promise<DegradationResult<T>> {
      if (adapter) await ensureCapabilities();
      const result = await runWithDegradation<T>({
        hasCredential,
        ...(adapter ? { adapter } : {}),
        messages: params.messages,
        ...(params.schema ? { schema: params.schema } : {}),
        rulesFallback: params.rulesFallback,
        ...(params.task ? { task: params.task } : {}),
        ...(params.opts ? { opts: params.opts } : {}),
        ...(params.onSchemaError ? { onSchemaError: params.onSchemaError } : {}),
      });
      tracker.record(result);
      return result;
    },
  };
}

/** 供 doctor / 设置页使用：不抛错地构造一次服务（配置错误转成可读结果） */
export function tryCreateLLM(
  env: Env,
  options: CreateLLMOptions = {},
): { ok: true; service: LLMService } | { ok: false; error: ProviderError } {
  try {
    return { ok: true, service: createLLM(env, options) };
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, error };
    throw error;
  }
}

export { resolveTaskModel };
export type { Capabilities, ProbeResult, ProviderAdapter };
