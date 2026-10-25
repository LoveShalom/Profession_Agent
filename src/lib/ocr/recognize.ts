/**
 * 截图识别（F-04 / T2，Q-09 裁决 = 方案 A：仅视觉模型）
 *
 * 设计约束（来自 F-04 §1.2）：
 *   **OCR 只负责"图 → 文本"，不直接产出结构化字段。**
 *   识别出的文本立刻回到 F-02 的 `cleanJd → extractJd` 管线，
 *   因此图片输入与文字输入的字段契约、三态截止、技能属性、K=3 一致性、校验完全一致。
 *
 * 多图与长图：客户端把长截图切成带 10% 重叠的片段后一起提交，
 * 服务端逐张识别，再按**行级重叠**去重拼接（重叠区是切片造成的重复，不是内容重复）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ProviderError } from '../errors.ts';
import type { LLMService } from '../llm/index.ts';
import { supportsVision, visionModelSuggestions } from '../llm/registry.ts';
import type { ChatMessage } from '../llm/types.ts';

/** 单次最多 5 张（长截图切片后通常 2–3 张） */
export const MAX_IMAGES = 5;
/** 单张 ≤10MB（base64 后约 13.3MB） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 40_000;
/** 短于此长度视为"没识别出内容" */
export const MIN_TEXT_CHARS = 20;

export type OcrErrorCode =
  | 'E_IMAGE_UNSUPPORTED'
  | 'E_IMAGE_TOO_MANY'
  | 'E_OCR_UNAVAILABLE'
  | 'E_OCR_UNSUPPORTED_MODEL'
  | 'E_OCR_EMPTY'
  | 'E_OCR_FAILED';

export interface OcrSuccess {
  ok: true;
  text: string;
  engine: 'vlm';
  imageCount: number;
  warnings: string[];
}

export interface OcrFailure {
  ok: false;
  code: OcrErrorCode;
  message: string;
  hint?: string;
  suggestions?: string[];
}

export type OcrResult = OcrSuccess | OcrFailure;

const DATA_URL_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,/i;

const FALLBACK_PROMPT = [
  '你是 OCR 引擎。把图片里的文字逐字转录出来。',
  '只输出转录文本，不要解释、不要总结、不要补全。',
  '保持阅读顺序与换行；表格行用 ` | ` 分隔。',
  '看不清的字符用 □ 代替；纯图片/空白只输出：（无文字）',
].join('\n');

let cachedPrompt: string | null = null;

/** 读取 OCR prompt（唯一真源 `prompts/ocr-image.md`，读不到时用内置兜底） */
export function loadOcrPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  try {
    const file = path.resolve('prompts/ocr-image.md');
    const text = readFileSync(file, 'utf8').trim();
    if (text.length > 0) {
      cachedPrompt = text;
      return text;
    }
  } catch {
    /* 打包/测试环境可能没有该文件，走兜底 */
  }
  cachedPrompt = FALLBACK_PROMPT;
  return cachedPrompt;
}

/** 构造一条"读图"消息（OpenAI 兼容 parts 格式） */
export function buildOcrMessages(imageDataUrl: string, prompt: string = loadOcrPrompt()): ChatMessage[] {
  return [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请转录这张招聘截图中的全部文字。' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

/** base64 体积估算（比实际字节略大，宁可保守） */
function estimateBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((base64.length * 3) / 4);
}

export function validateImages(images: readonly string[]): OcrFailure | null {
  if (images.length === 0) {
    return { ok: false, code: 'E_IMAGE_UNSUPPORTED', message: '没有收到图片' };
  }
  if (images.length > MAX_IMAGES) {
    return {
      ok: false,
      code: 'E_IMAGE_TOO_MANY',
      message: `最多 ${MAX_IMAGES} 张图片（当前 ${images.length} 张）`,
      hint: '长截图会自动切片，通常 2–3 张就够；请减少图片数量',
    };
  }
  for (const [index, dataUrl] of images.entries()) {
    if (!DATA_URL_PATTERN.test(dataUrl)) {
      return {
        ok: false,
        code: 'E_IMAGE_UNSUPPORTED',
        message: `第 ${index + 1} 张不是受支持的图片格式`,
        hint: '支持 PNG / JPEG / WebP',
      };
    }
    if (estimateBytes(dataUrl) > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        code: 'E_IMAGE_UNSUPPORTED',
        message: `第 ${index + 1} 张图片超过 10MB`,
        hint: '可以先裁剪掉与招聘无关的部分（广告位/推荐位），或压缩后再试',
      };
    }
  }
  return null;
}

/** 清理模型输出：去掉代码块包裹与常见客套前缀 */
export function cleanOcrText(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fence) text = fence[1]!.trim();
  text = text.replace(/^(以下是识别结果|识别结果|转录结果)[:：]\s*/u, '');
  if (text === '（无文字）' || text === '(无文字)') return '';
  return text.trim();
}

/**
 * 行级重叠去重：把切片造成的重复行去掉。
 * 取"上一段末尾 k 行 == 下一段开头 k 行"的最大 k（最多 8 行）。
 */
export function stitchOcrTexts(chunks: readonly string[]): string {
  let combined: string[] = [];
  for (const chunk of chunks) {
    const lines = chunk
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]!.length > 0));
    if (lines.length === 0) continue;

    let overlap = 0;
    const max = Math.min(8, combined.length, lines.length);
    for (let k = max; k >= 1; k -= 1) {
      const tail = combined.slice(combined.length - k).map((line) => line.trim());
      const head = lines.slice(0, k).map((line) => line.trim());
      if (tail.every((line, index) => line === head[index])) {
        overlap = k;
        break;
      }
    }
    combined = [...combined, ...lines.slice(overlap)];
  }
  return combined.join('\n').trim();
}

export interface RecognizeOptions {
  service: LLMService | null;
  /** 当前配置的 provider（决定是否具备视觉能力） */
  provider: string;
  /** 当前配置的模型名 */
  model: string;
  prompt?: string;
}

/** 识别多张图片 → 拼接文本。失败返回带可操作提示的错误（不用抛异常，UI 要直接渲染） */
export async function recognizeImages(images: readonly string[], options: RecognizeOptions): Promise<OcrResult> {
  const invalid = validateImages(images);
  if (invalid) return invalid;

  if (!options.service || !options.service.hasCredential) {
    return {
      ok: false,
      code: 'E_OCR_UNAVAILABLE',
      message: '当前没有配置可用的模型，无法识别图片',
      hint: '截图输入需要视觉模型。你可以：① 在 .env 配一个支持图片的模型（见下方建议）；② 直接粘贴 JD 文字',
      suggestions: visionModelSuggestions(options.provider),
    };
  }

  if (!supportsVision(options.provider, options.model)) {
    return {
      ok: false,
      code: 'E_OCR_UNSUPPORTED_MODEL',
      message: `当前模型「${options.model || '默认模型'}」不支持读取图片`,
      hint: '把 LLM_MODEL 换成支持视觉的模型后重启；或先手动粘贴 JD 文字',
      suggestions: visionModelSuggestions(options.provider),
    };
  }

  const prompt = options.prompt ?? loadOcrPrompt();
  const chunks: string[] = [];
  const warnings: string[] = [];

  for (const [index, dataUrl] of images.entries()) {
    try {
      // 走统一执行入口（L0–L4 降级链都覆盖）：OCR 不需要结构化 schema，只要文本
      const result = await options.service.run<string>({
        messages: buildOcrMessages(dataUrl, prompt),
        rulesFallback: () => '',
        task: 'extract',
      });
      if (result.status !== 'ok' || typeof result.data !== 'string' || result.data.trim().length === 0) {
        const reason = result.banner ?? `模型调用未成功（${result.level ?? '未知层级'}/${result.status}）`;
        return {
          ok: false,
          code: 'E_OCR_FAILED',
          message: `第 ${index + 1} 张识别失败：${reason}`,
          hint: '检查模型连通性与是否支持图片输入（npm run doctor）；也可先手动粘贴文字',
          suggestions: visionModelSuggestions(options.provider),
        };
      }
      const text = cleanOcrText(result.data);
      if (text.length > 0) chunks.push(text);
      else warnings.push(`第 ${index + 1} 张未识别到文字`);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'config') {
        return {
          ok: false,
          code: 'E_OCR_UNSUPPORTED_MODEL',
          message: `模型拒绝了图片输入：${error.message}`,
          hint: '该端点可能不支持多模态消息；请改用视觉模型，或手动粘贴文字',
          suggestions: visionModelSuggestions(options.provider),
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: 'E_OCR_FAILED',
        message: `第 ${index + 1} 张识别失败：${message}`,
        hint: '检查模型连通性（npm run doctor）后重试；也可先手动粘贴文字',
      };
    }
  }

  let text = stitchOcrTexts(chunks).trim();
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    warnings.push(`识别文本过长，已截断到 ${MAX_TEXT_CHARS} 字`);
  }
  if (text.length < MIN_TEXT_CHARS) {
    return {
      ok: false,
      code: 'E_OCR_EMPTY',
      message: '没有从图片中识别到有效文字',
      hint: '确认截图包含 JD 正文（不是登录框/验证码），或裁掉无关区域后重试；也可以直接粘贴文字',
    };
  }

  if (images.length > 1) warnings.push(`已合并 ${images.length} 张图片的识别结果`);

  return { ok: true, text, engine: 'vlm', imageCount: images.length, warnings };
}
