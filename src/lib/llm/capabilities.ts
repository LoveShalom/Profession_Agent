/**
 * A12 能力探测与缓存（I0 / T5）
 *
 * 为什么需要：BYOK 意味着用户可能接任何模型——有的不支持 tool calling、有的窗口只有 8k、
 * 有的没有 embedding。与其在业务里到处 try/catch，不如"探测一次、缓存 24h、按能力分流"。
 *
 * 能力来源优先级：显式声明（配置）> 探测/自学习（调用中被上游否定）> 预设默认表。
 * 每种来源都记录在 `source` 字段里，便于 doctor 与评测报告解释"为什么走了这条路径"。
 */

import type { Capabilities, ProbeResult, ProviderAdapter } from './types.ts';
import type { ProviderPreset } from './registry.ts';

export const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

export interface CapabilitiesSnapshot {
  provider: string;
  model: string;
  capabilities: Capabilities;
  /** 探测时间（epoch ms） */
  probedAt: number;
}

/** 能力缓存接口：默认内存实现；接 DB 时替换即可（见 tech_stack §9.2 user_llm_credentials.capabilities） */
export interface CapabilitiesStore {
  get(provider: string, model: string): CapabilitiesSnapshot | undefined;
  set(snapshot: CapabilitiesSnapshot): void;
  invalidate(provider?: string, model?: string): void;
}

export function createMemoryCapabilitiesStore(): CapabilitiesStore {
  const map = new Map<string, CapabilitiesSnapshot>();
  const key = (provider: string, model: string) => `${provider}::${model}`;
  return {
    get: (provider, model) => map.get(key(provider, model)),
    set: (snapshot) => {
      map.set(key(snapshot.provider, snapshot.model), snapshot);
    },
    invalidate: (provider, model) => {
      if (provider && model) {
        map.delete(key(provider, model));
        return;
      }
      if (provider) {
        for (const k of [...map.keys()]) if (k.startsWith(`${provider}::`)) map.delete(k);
        return;
      }
      map.clear();
    },
  };
}

/** 依据预设表构造初始能力（未探测时的兜底） */
export function capabilitiesFromPreset(preset: ProviderPreset): Capabilities {
  return { ...preset.defaults, source: 'default' };
}

/** 合并"预设默认"与"用户显式声明"，后者优先；未声明任何能力字段时保留原 source */
export function mergeCapabilities(base: Capabilities, declared?: Partial<Capabilities>): Capabilities {
  if (!declared) return { ...base };
  const hasExplicitField =
    declared.tool_calling !== undefined ||
    declared.json_schema !== undefined ||
    declared.stream !== undefined ||
    declared.embedding !== undefined ||
    declared.context_window !== undefined ||
    declared.max_output !== undefined;
  return {
    tool_calling: declared.tool_calling ?? base.tool_calling,
    json_schema: declared.json_schema ?? base.json_schema,
    stream: declared.stream ?? base.stream,
    embedding: declared.embedding ?? base.embedding,
    context_window: declared.context_window ?? base.context_window,
    max_output: declared.max_output ?? base.max_output,
    // 显式传入的 source 优先（例如探测结果）；否则按"是否声明了能力字段"判定
    source: declared.source ?? (hasExplicitField ? 'declared' : base.source),
  };
}

export interface CachedCapabilitiesResult {
  capabilities: Capabilities;
  probed: boolean;
  /** 探测失败时的原因（能力仍可回退到预设/声明值） */
  probeDetail?: string;
  latencyMs?: number;
}

/**
 * 取能力：命中未过期缓存直接用；否则探测一次并写入缓存。
 * 探测失败不抛错——能力回退到预设/声明值，由调用方决定是否提示用户（AC-4/AC-5 的判定在保存凭证处）。
 */
export async function resolveCapabilities(params: {
  adapter: ProviderAdapter;
  store: CapabilitiesStore;
  provider: string;
  model: string;
  fallback: Capabilities;
  now?: () => number;
  ttlMs?: number;
  /** 跳过探测（离线/doctor --no-network） */
  skipProbe?: boolean;
}): Promise<CachedCapabilitiesResult> {
  const now = params.now ?? (() => Date.now());
  const ttl = params.ttlMs ?? CAPABILITY_TTL_MS;

  const cached = params.store.get(params.provider, params.model);
  if (cached && now() - cached.probedAt < ttl) {
    return { capabilities: cached.capabilities, probed: false };
  }

  if (params.skipProbe) {
    return { capabilities: params.fallback, probed: false };
  }

  const probe: ProbeResult = await params.adapter.probe();
  if (!probe.ok) {
    return { capabilities: params.fallback, probed: true, probeDetail: probe.detail, latencyMs: probe.latencyMs };
  }

  const capabilities: Capabilities = { ...params.fallback, ...probe.capabilities, source: 'probe' };
  params.store.set({ provider: params.provider, model: params.model, capabilities, probedAt: now() });
  return { capabilities, probed: true, latencyMs: probe.latencyMs };
}

/** 人就绪的能力摘要（doctor / 设置页展示） */
export function describeCapabilities(capabilities: Capabilities): string {
  const flags = [
    capabilities.tool_calling ? 'tool_calling ✓' : 'tool_calling ✗',
    capabilities.json_schema ? 'json_schema ✓' : 'json_schema ✗',
    capabilities.embedding ? 'embedding ✓' : 'embedding ✗',
    capabilities.context_window ? `context ${capabilities.context_window}` : 'context 未知',
  ];
  return `${flags.join(' | ')} (source=${capabilities.source})`;
}

/** 上下文窗口是否够用（不足则强制分段，避免"超长 JD 丢信息"） */
export function isContextSufficient(capabilities: Capabilities, requestChars: number, safetyRatio = 0.6): boolean {
  if (!capabilities.context_window) return true; // 未知时不拦，交给分段策略兜底
  // 中文大致 1 字 ≈ 1 token 量级，留出 40% 余量给指令与输出
  const budget = Math.floor(capabilities.context_window * safetyRatio);
  return requestChars <= budget;
}
