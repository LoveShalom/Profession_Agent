/**
 * 降级链执行器 L0–L4（I0 / T5）
 *
 * 严格对应 F-01 §1.3-C 的分支契约：
 *   L0 有 Key + 支持 FC        → tool calling + JSON Schema        → ok
 *   L1 无 json_schema/不支持 FC → Prompt-JSON + 校验 + 修复重试 ≤2  → ok
 *   L2 L1 修复仍失败            → SchemaError（默认转 L3，可配置为直接抛出）
 *   L3 Key 失效 / 429 耗尽 / 不可达 / 5xx → 规则抽取 + 全字段待确认 → degraded
 *   L4 未配置 Key              → 规则抽取                          → degraded
 *
 * 注意例外：**config 类错误不降级**（出站被拒、私网被拒、模型名写错）。
 * 这类问题"请求根本没发出去"，静默降级会掩盖真实配置错误；因此返回 failed 并把修复建议交给 UI。
 *
 * 返回值是一等公民（而非抛异常），因为"降级"是正常业务结果，需要驱动 UI 横幅、用量标记与评测统计。
 */

import { ProviderError } from '../errors.ts';
import type { ChatMessage, ChatOptions, ProviderAdapter, SchemaLike, TaskName } from './types.ts';

export type DegradationLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type DegradationStatus = 'ok' | 'degraded' | 'failed';
export type ExecutionPath = 'tool_calling' | 'prompt_json' | 'rules';

export interface DegradationResult<T> {
  level: DegradationLevel;
  status: DegradationStatus;
  /** 是否发生了降级（用于 llm_usage_logs.degraded 与评测统计） */
  degraded: boolean;
  data?: T;
  error?: ProviderError;
  path: ExecutionPath;
  /** 降级原因（可多条） */
  reasons: string[];
  /** 顶部横幅文案；ok 时为 undefined */
  banner?: string;
}

export interface RunWithDegradationParams<T> {
  hasCredential: boolean;
  adapter?: ProviderAdapter;
  messages: ChatMessage[];
  /** 结构化抽取时提供；不提供则走纯文本对话 */
  schema?: SchemaLike<T>;
  /** L3/L4 的规则结果（F-01 要求"无密钥可用"，所以这是必填） */
  rulesFallback: () => T;
  task?: TaskName;
  opts?: ChatOptions;
  /** 收到 SchemaError 时的行为，默认转 L3（用户仍能拿到可用结果） */
  onSchemaError?: 'degrade' | 'throw';
}

function bannerFor(error: ProviderError): string {
  switch (error.kind) {
    case 'auth':
      return '⚠️ 模型 API Key 失效或权限不足，已切换为规则模式；请在设置页更新 Key 后重试。';
    case 'rate_limit':
      return '⚠️ 上游限流，已切换为规则模式；稍后重试可获得 AI 抽取结果。';
    case 'unreachable':
      return '⚠️ 无法连接模型服务，已切换为规则模式；请检查 LLM_BASE_URL 与网络。';
    case 'server':
      return '⚠️ 模型服务异常，已切换为规则模式；稍后重试即可。';
    case 'schema':
      return '⚠️ 模型输出未通过结构校验，已切换为规则模式；请复核标红的字段。';
    case 'capability':
      return `⚠️ 当前模型缺少能力「${error.missing ?? 'unknown'}」，已切换为规则模式。`;
    default:
      return '⚠️ 已切换为规则模式。';
  }
}

export async function runWithDegradation<T>(params: RunWithDegradationParams<T>): Promise<DegradationResult<T>> {
  const { hasCredential, adapter, schema } = params;

  // ---------- L4：未配置凭证 ----------
  if (!hasCredential || !adapter) {
    return {
      level: 'L4',
      status: 'degraded',
      degraded: true,
      data: params.rulesFallback(),
      path: 'rules',
      reasons: ['未配置模型 API Key'],
      banner: 'ℹ️ 尚未配置模型：当前为规则模式，字段全部需要人工确认。配置模型后可自动抽取。',
    };
  }

  // ---------- L0 / L1：交给适配层内部自动选择路径 ----------
  try {
    if (schema) {
      const { data, result } = await adapter.chatJSON<T>(params.messages, schema, {
        task: params.task ?? 'extract',
        ...(params.opts ?? {}),
      });
      const level: DegradationLevel = result.path === 'tool_calling' ? 'L0' : 'L1';
      return {
        level,
        status: 'ok',
        degraded: false,
        data,
        path: result.path,
        reasons: [],
      };
    }

    const result = await adapter.chat(params.messages, { task: params.task ?? 'generate', ...(params.opts ?? {}) });
    return {
      level: 'L0',
      status: 'ok',
      degraded: false,
      data: result.text as unknown as T,
      path: 'prompt_json',
      reasons: [],
    };
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : ProviderError.unreachable(error, adapter.config.baseUrl);

    // ---------- config 类：不降级，直接暴露（避免掩盖配置错误） ----------
    if (providerError.kind === 'config') {
      return {
        level: 'L2',
        status: 'failed',
        degraded: false,
        error: providerError,
        path: 'rules',
        reasons: [`配置错误：${providerError.message}`],
        banner: `❌ ${providerError.message} —— ${providerError.userHint}`,
      };
    }

    // ---------- L2：结构化输出失败，按配置决定抛出或转 L3 ----------
    if (providerError.kind === 'schema' && (params.onSchemaError ?? 'degrade') === 'throw') {
      return {
        level: 'L2',
        status: 'failed',
        degraded: false,
        error: providerError,
        path: 'prompt_json',
        reasons: ['结构化输出校验失败（已尝试修复重试）'],
        banner: `❌ ${providerError.userHint}`,
      };
    }

    // ---------- L3：其余可降级错误 → 规则模式 ----------
    return {
      level: 'L3',
      status: 'degraded',
      degraded: true,
      data: params.rulesFallback(),
      error: providerError,
      path: 'rules',
      reasons: [`${providerError.kind}：${providerError.message}`],
      banner: bannerFor(providerError),
    };
  }
}

/** 降级统计（评测报告 / doctor 展示"降级率"） */
export class DegradationTracker {
  private counts: Record<DegradationLevel, number> = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 };

  record(result: Pick<DegradationResult<unknown>, 'level' | 'status'>): void {
    this.counts[result.level] += 1;
  }

  snapshot(): { counts: Record<DegradationLevel, number>; total: number; degradedRate: number } {
    const total = Object.values(this.counts).reduce((a, b) => a + b, 0);
    const degraded = this.counts.L3 + this.counts.L4;
    return {
      counts: { ...this.counts },
      total,
      degradedRate: total === 0 ? 0 : degraded / total,
    };
  }
}
