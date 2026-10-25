/**
 * Provider 注册表（I0 / T4）
 *
 * 只放"数据"，不放逻辑：新增一个 provider = 在这里加一行（对应 F-01 的 AC-13：
 * 新增 provider 只改配置 + 注册表一处）。地址与默认模型名以各厂商 OpenAI 兼容端点为准；
 * 若厂商改名或调整，只需更新本表，业务代码零改动。
 */

import { ProviderError } from '../errors.ts';

export interface ProviderPreset {
  /** 预设名（与 LLM_PROVIDER 取值一致） */
  name: string;
  /** 展示名 */
  label: string;
  /** OpenAI 兼容端点（不含 /chat/completions） */
  baseUrl: string;
  /** 默认模型名 */
  defaultModel: string;
  /** 是否允许留空 API Key（本地模型） */
  keyOptional?: boolean;
  /** 是否通常为私网地址（需要 ALLOW_PRIVATE_BASE_URL） */
  privateByDefault?: boolean;
  /** 已知能力（未探测时的内置默认；探测结果优先） */
  defaults: {
    tool_calling: boolean;
    json_schema: boolean;
    stream: boolean;
    embedding: boolean;
    context_window: number;
    max_output: number;
  };
  /** 控制台/文档链接，doctor 提示用 */
  docs?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    name: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaults: { tool_calling: true, json_schema: true, stream: true, embedding: false, context_window: 65536, max_output: 8192 },
    docs: 'https://platform.deepseek.com',
  },
  {
    name: 'qwen',
    label: '阿里云百炼 Qwen（OpenAI 兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    defaults: { tool_calling: true, json_schema: true, stream: true, embedding: false, context_window: 131072, max_output: 8192 },
    docs: 'https://bailian.console.aliyun.com',
  },
  {
    name: 'kimi',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    defaults: { tool_calling: true, json_schema: false, stream: true, embedding: false, context_window: 8192, max_output: 4096 },
    docs: 'https://platform.moonshot.cn',
  },
  {
    name: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    defaults: { tool_calling: true, json_schema: false, stream: true, embedding: false, context_window: 131072, max_output: 4096 },
    docs: 'https://open.bigmodel.cn',
  },
  {
    name: 'siliconflow',
    label: '硅基流动 SiliconFlow（含 Embedding）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    defaults: { tool_calling: true, json_schema: false, stream: true, embedding: true, context_window: 32768, max_output: 4096 },
    docs: 'https://siliconflow.cn',
  },
  {
    name: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    defaults: { tool_calling: true, json_schema: true, stream: true, embedding: true, context_window: 128000, max_output: 16384 },
    docs: 'https://platform.openai.com',
  },
  {
    name: 'ollama',
    label: 'Ollama（本地模型，可完全离线）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    keyOptional: true,
    privateByDefault: true,
    defaults: { tool_calling: true, json_schema: false, stream: true, embedding: true, context_window: 32768, max_output: 4096 },
    docs: 'https://ollama.com',
  },
];

/** provider=custom：用户自填 base_url（含 one-api / new-api / OpenRouter 等中转站） */
export const CUSTOM_PROVIDER: ProviderPreset = {
  name: 'custom',
  label: '自定义 OpenAI 兼容端点',
  baseUrl: '',
  defaultModel: '',
  keyOptional: false,
  defaults: { tool_calling: false, json_schema: false, stream: true, embedding: false, context_window: 0, max_output: 0 },
};

export interface ResolveProviderInput {
  provider: string;
  baseUrl?: string;
  model?: string;
  allowPrivateBaseUrl: boolean;
}

export interface ResolvedProvider {
  preset: ProviderPreset;
  baseUrl: string;
  model: string;
  /** 用户是否显式覆盖了地址 */
  baseUrlOverridden: boolean;
  modelOverridden: boolean;
}

/**
 * 解析 provider 配置。
 * 失败一律抛 ProviderError('config')，带可执行提示（AC-4/AC-5/AC-8 要求能自解释）。
 */
export function resolveProvider(input: ResolveProviderInput): ResolvedProvider {
  const name = (input.provider || 'deepseek').trim().toLowerCase();
  const isCustom = name === 'custom';
  const preset = isCustom ? CUSTOM_PROVIDER : PROVIDER_PRESETS.find((p) => p.name === name);

  if (!preset) {
    throw ProviderError.config(
      `未知的 LLM_PROVIDER："${input.provider}"`,
      `可选值：${[...PROVIDER_PRESETS.map((p) => p.name), 'custom'].join(' / ')}`,
    );
  }

  const baseUrlOverridden = Boolean(input.baseUrl && input.baseUrl.trim() !== '');
  const baseUrl = (baseUrlOverridden ? input.baseUrl!.trim() : preset.baseUrl).replace(/\/+$/, '');
  const modelOverridden = Boolean(input.model && input.model.trim() !== '');
  const model = modelOverridden ? input.model!.trim() : preset.defaultModel;

  if (!baseUrl) {
    throw ProviderError.config(
      'LLM_PROVIDER=custom 时必须提供 LLM_BASE_URL',
      '例如：LLM_BASE_URL=https://your-gateway.example.com/v1',
    );
  }
  if (!model) {
    throw ProviderError.config(
      'LLM_PROVIDER=custom 时必须提供 LLM_MODEL',
      '例如：LLM_MODEL=qwen-plus（填你的网关所支持的模型名）',
    );
  }

  return { preset, baseUrl, model, baseUrlOverridden, modelOverridden };
}

/** 判断解析出的主机名是否"像"一个真实主机名（用于忽略用户填错的裸词） */
export function isPlausibleHostname(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 字面量
  if (host.includes(':')) return true; // IPv6 字面量
  return host.includes('.'); // FQDN：必须带点，否则视为误填
}

/** 出站白名单：只允许访问用户配置的 provider 域名（+ 显式额外域名） */
export function allowedEgressHosts(params: {
  providerBaseUrl: string;
  extraHosts?: string[];
  telemetryHost?: string;
}): string[] {
  const hosts = new Set<string>();
  /** 同时接受完整 URL 与裸域名（EGRESS_EXTRA_HOSTS 用户通常只写域名） */
  const add = (value?: string) => {
    const raw = value?.trim();
    if (!raw) return;
    const asUrl = raw.includes('://') ? raw : `https://${raw}`;
    try {
      const host = new URL(asUrl).hostname.toLowerCase();
      if (isPlausibleHostname(host)) hosts.add(host);
    } catch {
      /* 非法地址在 resolveProvider / guard 阶段已拦截 */
    }
  };
  add(params.providerBaseUrl);
  add(params.telemetryHost);
  for (const host of params.extraHosts ?? []) add(host);
  return [...hosts].filter(Boolean).sort();
}

/** 任务的默认模型解析（任务级模型偏好，见 tech_stack §3.3） */
export function resolveTaskModel(params: {
  task: 'extract' | 'generate' | 'embed';
  model: string;
  modelExtract?: string;
  modelGenerate?: string;
  embeddingModel?: string;
}): string {
  if (params.task === 'extract') return params.modelExtract?.trim() || params.model;
  if (params.task === 'generate') return params.modelGenerate?.trim() || params.model;
  return params.embeddingModel?.trim() || params.model;
}

// ---------------------------------------------------------------- 视觉能力（F-04 截图 OCR）
/**
 * 视觉能力**无法像 tool calling 那样探测**（探测本身就要发一张图，成本与失败面都不划算），
 * 因此按"provider + 模型名是否命中已知视觉模型"来判断：
 *   - 命中 → 允许走截图识别；
 *   - 未命中 → 明确告知"当前模型不支持读图"并给出该 provider 的可选视觉模型；
 *   - custom 网关：无法判断，放行（调用失败会降级为可操作提示）。
 */
const VISION_MODEL_PATTERNS: Record<string, readonly string[]> = {
  // 2026-10 复核：DeepSeek-Flash（V4.1-Flash）已支持 Vision（官方定价页 "Vision ✓"）
  deepseek: ['deepseek-flash', 'vision'],
  qwen: ['qwen-vl', 'qwen2-vl', 'qwen2.5-vl', 'qwen3-vl'],
  kimi: ['vision'],
  glm: ['glm-4v', 'glm-4.1v', 'glm-4.5v', 'glm-4v-flash', 'glm-ocr'],
  siliconflow: ['vl', 'vision'],
  openai: ['gpt-4o', 'gpt-4.1', 'gpt-4-vision', 'gpt-5'],
  ollama: ['llava', 'qwen2-vl', 'qwen2.5-vl', 'minicpm-v', 'moondream'],
};

const VISION_MODEL_SUGGESTIONS: Record<string, readonly string[]> = {
  deepseek: ['deepseek-flash（单 Key 即可，同时也做文本）'],
  qwen: ['qwen-vl-plus', 'qwen2.5-vl-7b-instruct'],
  kimi: ['moonshot-v1-vision-preview'],
  glm: ['glm-4v-flash（官方免费图像理解模型）', 'glm-4.1v-flash'],
  siliconflow: ['Qwen/Qwen2.5-VL-7B-Instruct'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini'],
  ollama: ['qwen2.5vl:7b', 'llava:7b'],
};

export function supportsVision(provider: string, model: string): boolean {
  const name = (provider || '').trim().toLowerCase();
  const target = (model || '').trim().toLowerCase();
  if (name === 'custom') return true;
  if (target.length === 0) return false;
  const patterns = VISION_MODEL_PATTERNS[name] ?? [];
  return patterns.some((pattern) => target.includes(pattern));
}

/** 给 UI/错误提示用的候选视觉模型 */
export function visionModelSuggestions(provider: string): string[] {
  const name = (provider || '').trim().toLowerCase();
  return [...(VISION_MODEL_SUGGESTIONS[name] ?? ['请填写一个支持图片输入的模型名，例如 *-vl / *-vision / gpt-4o'])];
}

/** 当前配置是否具备读图能力（供 doctor / 设置页展示） */
export function describeVisionSupport(provider: string, model: string): string {
  return supportsVision(provider, model)
    ? `视觉 ✓（${model || '默认模型'}）`
    : `视觉 ✗（${model || '默认模型'}）→ 截图输入不可用，可用：${visionModelSuggestions(provider)[0]}`;
}
