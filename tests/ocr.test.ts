import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderError } from '../src/lib/errors.ts';
import type { LLMService } from '../src/lib/llm/index.ts';
import { supportsVision, visionModelSuggestions } from '../src/lib/llm/registry.ts';
import {
  MAX_IMAGES,
  buildOcrMessages,
  cleanOcrText,
  recognizeImages,
  stitchOcrTexts,
  validateImages,
} from '../src/lib/ocr/recognize.ts';

/** 1x1 PNG 的 data URL（内容不重要，只验证格式与流程） */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DEFAULT_TEXT = '某科技有限公司 招聘 后端开发工程师\n工作地点：上海\n技能要求：熟悉 Java';

function fakeService(handler: (messages: unknown) => Promise<string> | string = () => DEFAULT_TEXT): LLMService {
  return {
    hasCredential: true,
    run: async (params: { messages: unknown }) => ({
      status: 'ok',
      data: await handler(params.messages),
      level: 'L0',
      path: 'prompt_json',
      degraded: false,
    }),
  } as unknown as LLMService;
}

// ---------------------------------------------------------------- 视觉能力判定
test('supportsVision：按 provider + 模型名判定', () => {
  assert.equal(supportsVision('deepseek', 'deepseek-chat'), false, 'deepseek-chat 是纯文本模型');
  assert.equal(supportsVision('deepseek', 'deepseek-flash'), true, '2026-10 起 deepseek-flash 支持视觉');
  assert.equal(supportsVision('qwen', 'qwen-vl-plus'), true);
  assert.equal(supportsVision('qwen', 'qwen-plus'), false, '文本模型不能读图');
  assert.equal(supportsVision('glm', 'glm-4v-flash'), true);
  assert.equal(supportsVision('openai', 'gpt-4o-mini'), true);
  assert.equal(supportsVision('ollama', 'llava:7b'), true);
  assert.equal(supportsVision('custom', 'whatever-model'), true, '自定义网关放行，失败再兜底');
  assert.equal(supportsVision('deepseek', ''), false);
  assert.ok(
    visionModelSuggestions('deepseek')[0]!.includes('deepseek-flash'),
    'DeepSeek 应建议用它自家的视觉模型（省一个 Key）',
  );
  assert.ok(visionModelSuggestions('glm')[0]!.includes('glm-4v-flash'), '智谱免费视觉模型');
});

// ---------------------------------------------------------------- 消息构造
test('buildOcrMessages：包含 system prompt 与 image_url part', () => {
  const messages = buildOcrMessages(PNG, 'PROMPT');
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, 'system');
  assert.equal(messages[0]!.content, 'PROMPT');
  const parts = messages[1]!.content;
  assert.ok(Array.isArray(parts));
  assert.equal(parts[0]!.type, 'text');
  assert.equal(parts[1]!.type, 'image_url');
  assert.deepEqual((parts[1] as { image_url: { url: string } }).image_url.url, PNG);
});

// ---------------------------------------------------------------- 输入校验
test('validateImages：空 / 过多 / 格式错 / 过大', () => {
  assert.equal(validateImages([])?.code, 'E_IMAGE_UNSUPPORTED');
  assert.equal(validateImages(new Array(MAX_IMAGES + 1).fill(PNG))?.code, 'E_IMAGE_TOO_MANY');
  assert.equal(validateImages(['data:text/plain;base64,abc'])?.code, 'E_IMAGE_UNSUPPORTED');
  const huge = `data:image/png;base64,${'A'.repeat(15 * 1024 * 1024)}`;
  assert.equal(validateImages([huge])?.code, 'E_IMAGE_UNSUPPORTED');
  assert.equal(validateImages([PNG]), null);
});

// ---------------------------------------------------------------- 输出清理与拼接
test('cleanOcrText：去代码块与客套前缀，纯"无文字"视为空', () => {
  assert.equal(cleanOcrText('```\n某公司招聘\n```'), '某公司招聘');
  assert.equal(cleanOcrText('以下是识别结果：某公司'), '某公司');
  assert.equal(cleanOcrText('（无文字）'), '');
  assert.equal(cleanOcrText('  Java 工程师  '), 'Java 工程师');
});

test('stitchOcrTexts：切片重叠区去重', () => {
  const a = '第一段内容\n重叠行A\n重叠行B';
  const b = '重叠行A\n重叠行B\n第二段内容';
  assert.equal(stitchOcrTexts([a, b]), '第一段内容\n重叠行A\n重叠行B\n第二段内容');
  assert.equal(stitchOcrTexts(['只有一段']), '只有一段');
  assert.equal(stitchOcrTexts([]), '');
});

// ---------------------------------------------------------------- 识别编排
test('recognizeImages：无模型 → 可操作提示（两条路径 + 模型建议）', async () => {
  const result = await recognizeImages([PNG], { service: null, provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'E_OCR_UNAVAILABLE');
  assert.ok(result.hint?.includes('粘贴'));
  assert.ok((result.suggestions ?? []).length > 0);
});

test('recognizeImages：模型不支持读图 → 明确指出并给替代模型', async () => {
  const result = await recognizeImages([PNG], {
    service: fakeService(),
    provider: 'deepseek',
    model: 'deepseek-chat',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'E_OCR_UNSUPPORTED_MODEL');
  assert.ok(result.message.includes('deepseek-chat'));
  assert.ok((result.suggestions ?? []).length > 0);
});

test('recognizeImages：视觉模型识别成功 → 返回文本', async () => {
  const result = await recognizeImages([PNG], {
    service: fakeService(),
    provider: 'qwen',
    model: 'qwen-vl-plus',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.engine, 'vlm');
  assert.equal(result.imageCount, 1);
  assert.ok(result.text.includes('后端开发工程师'));
});

test('recognizeImages：多图合并 + 重叠去重 + 提示', async () => {
  const texts = [
    'A公司招聘后端开发工程师\n工作地点：上海\n重叠行：技能要求熟悉 Java',
    '重叠行：技能要求熟悉 Java\nB公司招聘数据分析师\n工作地点：北京',
  ];
  let call = 0;
  const service = fakeService(() => texts[call++]!);
  const result = await recognizeImages([PNG, PNG], { service, provider: 'qwen', model: 'qwen-vl-plus' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.imageCount, 2);
  assert.ok(result.text.includes('A公司招聘'));
  assert.ok(result.text.includes('B公司招聘'));
  assert.equal(result.text.match(/重叠行/g)?.length, 1, '重叠行只应出现一次');
  assert.ok(result.warnings.some((warning) => warning.includes('合并')));
});

test('recognizeImages：识别为空 → E_OCR_EMPTY 并提示换图', async () => {
  const result = await recognizeImages([PNG], {
    service: fakeService(() => '（无文字）'),
    provider: 'qwen',
    model: 'qwen-vl-plus',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'E_OCR_EMPTY');
  assert.ok(result.hint?.includes('粘贴'));
});

test('recognizeImages：端点拒绝图片 → 归为"模型不支持多模态"', async () => {
  const service = {
    hasCredential: true,
    run: async () => {
      throw ProviderError.config('该模型不支持图片输入', '请改用视觉模型');
    },
  } as unknown as LLMService;
  const result = await recognizeImages([PNG], { service, provider: 'qwen', model: 'qwen-vl-plus' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'E_OCR_UNSUPPORTED_MODEL');
});

test('recognizeImages：运行时错误 → E_OCR_FAILED 带排查建议', async () => {
  const service = {
    hasCredential: true,
    run: async () => {
      throw new Error('socket hang up');
    },
  } as unknown as LLMService;
  const result = await recognizeImages([PNG], { service, provider: 'qwen', model: 'qwen-vl-plus' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'E_OCR_FAILED');
  assert.ok(result.hint?.includes('doctor'));
});

test('recognizeImages：模型降级（未返回文本）→ 明确失败而非空结果', async () => {
  const service = {
    hasCredential: true,
    run: async () => ({ status: 'failed', data: '', level: 'L4', path: 'error', degraded: true, banner: '未配置模型' }),
  } as unknown as LLMService;
  const result = await recognizeImages([PNG], { service, provider: 'qwen', model: 'qwen-vl-plus' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'E_OCR_FAILED');
  assert.ok(result.message.includes('未配置模型'));
});
