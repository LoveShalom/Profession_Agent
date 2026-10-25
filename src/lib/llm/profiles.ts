/**
 * 多模型路由（F-04 扩展 / 决策 §17）
 *
 * 动机：**文本模型与视觉模型本来就该分开配**。
 *   · DeepSeek 没有视觉模型，日常抽取又便宜好用；
 *   · Qwen-VL / GLM-4V 能读图，但价格与延迟不适合做每次抽取。
 * 所以允许两套独立配置：`LLM_*`（文本/抽取）与 `LLM_VISION_*`（截图识别）。
 *
 * 架构取向：**对外两个 profile，对内是通用 router**。
 * 等 F-07（BYOK 设置页）落地后，`user_llm_credentials` 表里的任意多条凭证都可以
 * 作为额外 profile 接进来，而调用方（`/api/ocr`、`/api/parse-jd`）不需要改动。
 *
 * 向后兼容：`LLM_VISION_PROVIDER` 不配置时，行为与改造前完全一致
 * （文本功能正常，截图识别给出"未配置视觉模型"的可操作提示）。
 */

import type { Env } from '../env.ts';
import { ProviderError } from '../errors.ts';

import { createLLM, type CreateLLMOptions, type LLMService } from './index.ts';
import { resolveProvider, supportsVision, visionModelSuggestions } from './registry.ts';

export type ModelProfileName = 'text' | 'vision';

export interface ModelProfileInfo {
  name: ModelProfileName;
  /** 用户是否显式配置了该 profile */
  configured: boolean;
  provider: string;
  /** 解析后的模型名（未填时用 provider 默认） */
  model: string;
  baseUrl: string;
  hasCredential: boolean;
  /** 该模型是否支持读图 */
  supportsVision: boolean;
  /** 不可用原因（未配置 / 配置非法 / 私网未开 等） */
  reason?: string;
  suggestions?: string[];
}

export interface ModelRouter {
  /** 文本模型（抽取/生成/校验），始终存在；无 Key 时为规则模式 */
  text: LLMService;
  /** 视觉模型（截图识别），未配置或配置非法时为 null */
  vision: LLMService | null;
  info: { text: ModelProfileInfo; vision: ModelProfileInfo };
}

/** 视觉 profile 的派生 env：未配置返回 null */
export function buildVisionEnv(env: Env): Env | null {
  const provider = (env.llmVisionProvider ?? '').trim();
  if (provider.length === 0) return null;
  return {
    ...env,
    llmProvider: provider,
    llmBaseUrl: env.llmVisionBaseUrl,
    // 未单独填视觉 Key 时继承文本 Key（同一家服务商只要给模型名即可）
    llmApiKey: env.llmVisionApiKey ?? env.llmApiKey,
    llmModel: env.llmVisionModel,
    // 视觉任务不需要任务级模型覆盖，避免误把文本模型套到图片上
    llmModelExtract: undefined,
    llmModelGenerate: undefined,
  };
}

export function describeModelProfile(name: ModelProfileName, env: Env): ModelProfileInfo {
  const configured =
    name === 'text' ? true : (env.llmVisionProvider ?? '').trim().length > 0;
  const provider =
    name === 'text' ? env.llmProvider : (env.llmVisionProvider ?? '').trim() || env.llmProvider;
  const baseUrl = name === 'text' ? env.llmBaseUrl : env.llmVisionBaseUrl;
  const model = name === 'text' ? env.llmModel : env.llmVisionModel;
  const apiKey = name === 'text' ? env.llmApiKey : (env.llmVisionApiKey ?? env.llmApiKey);

  if (!configured) {
    return {
      name,
      configured: false,
      provider,
      model: '',
      baseUrl: baseUrl ?? '',
      hasCredential: false,
      supportsVision: false,
      reason: '未配置视觉模型：截图识别不可用（文本抽取不受影响）',
      suggestions: visionModelSuggestions('qwen'),
    };
  }

  try {
    const resolved = resolveProvider({
      provider,
      baseUrl,
      model,
      allowPrivateBaseUrl: env.allowPrivateBaseUrl,
    });
    const visionOk = supportsVision(resolved.preset.name, resolved.model);
    return {
      name,
      configured,
      provider: resolved.preset.name,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      hasCredential: resolved.preset.keyOptional ? true : Boolean(apiKey),
      supportsVision: visionOk,
      // 配了但不是视觉模型时也给候选模型，避免用户只看到"不支持"却不知道换什么
      ...(visionOk ? {} : { suggestions: visionModelSuggestions(resolved.preset.name) }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      configured,
      provider,
      model: model ?? '',
      baseUrl: baseUrl ?? '',
      hasCredential: false,
      supportsVision: false,
      reason: message,
      suggestions: visionModelSuggestions(provider),
    };
  }
}

/**
 * 构造 router。`vision` 的创建失败不抛异常，而是折成 `info.vision.reason`，
 * 让 API 能返回"为什么截图不可用"，而不是 500。
 */
export function createModelRouter(env: Env, options: CreateLLMOptions = {}): ModelRouter {
  const text = createLLM(env, options);
  const visionEnv = buildVisionEnv(env);
  let vision: LLMService | null = null;
  let visionInfo = describeModelProfile('vision', env);

  if (visionEnv) {
    if (!visionInfo.reason) {
      try {
        vision = createLLM(visionEnv, options);
      } catch (error) {
        const message = error instanceof ProviderError ? error.message : error instanceof Error ? error.message : String(error);
        visionInfo = { ...visionInfo, reason: message, suggestions: visionModelSuggestions(visionInfo.provider) };
      }
    }
  }

  return { text, vision, info: { text: describeModelProfile('text', env), vision: visionInfo } };
}

/** doctor / 日志用的可读摘要（不含密钥） */
export function describeModelRouting(router: ModelRouter): string {
  const flag = (info: ModelProfileInfo): string => {
    if (info.name === 'vision' && !info.configured) return '未配置';
    const mark = info.supportsVision ? '视觉 ✓' : '视觉 ✗';
    return `${info.provider} / ${info.model || '(默认模型)'}（${mark}）`;
  };
  const lines = [`文本：${flag(router.info.text)}`];
  lines.push(
    router.info.vision.configured
      ? `视觉：${flag(router.info.vision)}`
      : `视觉：${router.info.vision.reason ?? '未配置'}`,
  );
  return lines.join('\n');
}
