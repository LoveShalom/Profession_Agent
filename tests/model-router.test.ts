import test from 'node:test';
import assert from 'node:assert/strict';

import { describeEnv, generateEncryptionKey, validateEnv, type Env } from '../src/lib/env.ts';
import { createModelRouter, describeModelRouting, buildVisionEnv, describeModelProfile } from '../src/lib/llm/profiles.ts';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres',
  ENCRYPTION_KEY: generateEncryptionKey(),
};

function envWith(overrides: Record<string, string> = {}): Env {
  const result = validateEnv({ ...BASE, ...overrides });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result.env!;
}

// ---------------------------------------------------------------- 环境解析
test('env：视觉模型字段独立解析（三套配置可各用不同厂商）', () => {
  const env = envWith({
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: 'sk-text',
    LLM_MODEL: 'deepseek-chat',
    LLM_VISION_PROVIDER: 'qwen',
    LLM_VISION_API_KEY: 'sk-vision',
    LLM_VISION_MODEL: 'qwen-vl-plus',
  });
  assert.equal(env.llmProvider, 'deepseek');
  assert.equal(env.llmVisionProvider, 'qwen');
  assert.equal(env.llmVisionApiKey, 'sk-vision');
  assert.equal(env.llmVisionModel, 'qwen-vl-plus');
});

test('env：未配置视觉模型时为 undefined（向后兼容）', () => {
  const env = envWith({ LLM_PROVIDER: 'deepseek' });
  assert.equal(env.llmVisionProvider, undefined);
});

test('env：视觉 provider 非法值会被拒绝', () => {
  const result = validateEnv({ ...BASE, LLM_VISION_PROVIDER: 'not-a-provider' });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.key === 'LLM_VISION_PROVIDER'));
});

test('env：视觉 Key 不出现在 describeEnv（脱敏）', () => {
  const env = envWith({ LLM_API_KEY: 'sk-text-secret', LLM_VISION_PROVIDER: 'qwen', LLM_VISION_API_KEY: 'sk-vision-secret' });
  const text = describeEnv(env);
  assert.equal(text.includes('sk-vision-secret'), false, '不得出现视觉 Key 明文');
  assert.equal(text.includes('sk-text-secret'), false, '不得出现文本 Key 明文');
  assert.ok(text.includes('qwen'));
});

// ---------------------------------------------------------------- 路由
test('router：未配置视觉模型 → vision=null 且给出可操作原因', () => {
  const router = createModelRouter(envWith({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-text' }), { skipProbe: true });
  assert.ok(router.text);
  assert.equal(router.vision, null);
  assert.equal(router.info.vision.configured, false);
  assert.ok(router.info.vision.reason?.includes('未配置视觉模型'));
  assert.ok((router.info.vision.suggestions ?? []).length > 0);
});

test('router：配置视觉模型 → 独立 service，且识别为视觉能力', () => {
  const router = createModelRouter(
    envWith({
      LLM_PROVIDER: 'deepseek',
      LLM_API_KEY: 'sk-text',
      LLM_VISION_PROVIDER: 'qwen',
      LLM_VISION_MODEL: 'qwen-vl-plus',
      LLM_VISION_API_KEY: 'sk-vision',
    }),
    { skipProbe: true },
  );
  assert.ok(router.vision, '应创建独立的视觉 service');
  assert.equal(router.info.vision.provider, 'qwen');
  assert.equal(router.info.vision.model, 'qwen-vl-plus');
  assert.equal(router.info.vision.supportsVision, true);
  assert.equal(router.info.text.provider, 'deepseek', '文本 profile 不受影响');
});

test('router：视觉 Key 留空 → 继承文本 Key', () => {
  const router = createModelRouter(
    envWith({ LLM_PROVIDER: 'qwen', LLM_API_KEY: 'sk-shared', LLM_VISION_PROVIDER: 'qwen', LLM_VISION_MODEL: 'qwen-vl-plus' }),
    { skipProbe: true },
  );
  assert.equal(router.info.vision.hasCredential, true);
});

test('router：配了但不是视觉模型 → 仍创建 service，但标记 supportsVision=false', () => {
  const router = createModelRouter(
    envWith({ LLM_PROVIDER: 'qwen', LLM_API_KEY: 'sk', LLM_VISION_PROVIDER: 'qwen', LLM_VISION_MODEL: 'qwen-plus' }),
    { skipProbe: true },
  );
  assert.ok(router.vision);
  assert.equal(router.info.vision.supportsVision, false, 'qwen-plus 不能读图');
  assert.equal(router.info.text.supportsVision, false);
});

test('router：custom 视觉端点缺 baseUrl → 不抛异常，折成 reason', () => {
  const router = createModelRouter(
    envWith({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk', LLM_VISION_PROVIDER: 'custom', LLM_VISION_MODEL: 'my-vl' }),
    { skipProbe: true },
  );
  assert.equal(router.vision, null);
  assert.ok(router.info.vision.reason, '应给出不可用原因');
});

test('buildVisionEnv：派生环境变量正确（provider/key/model 覆盖，任务级模型清空）', () => {
  const env = envWith({
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: 'sk-text',
    LLM_MODEL: 'deepseek-chat',
    LLM_MODEL_EXTRACT: 'deepseek-chat',
    LLM_VISION_PROVIDER: 'glm',
    LLM_VISION_MODEL: 'glm-4v-flash',
  });
  const visionEnv = buildVisionEnv(env);
  assert.ok(visionEnv);
  assert.equal(visionEnv.llmProvider, 'glm');
  assert.equal(visionEnv.llmModel, 'glm-4v-flash');
  assert.equal(visionEnv.llmApiKey, 'sk-text', '未单独配置时继承文本 Key');
  assert.equal(visionEnv.llmModelExtract, undefined, '视觉任务不继承文本的任务级模型');
  assert.equal(buildVisionEnv(envWith({ LLM_PROVIDER: 'deepseek' })), null);
});

test('describeModelRouting：可读摘要包含两类模型', () => {
  const router = createModelRouter(
    envWith({ LLM_PROVIDER: 'qwen', LLM_API_KEY: 'sk', LLM_VISION_PROVIDER: 'qwen', LLM_VISION_MODEL: 'qwen-vl-plus' }),
    { skipProbe: true },
  );
  const text = describeModelRouting(router);
  assert.ok(text.includes('文本：'));
  assert.ok(text.includes('视觉：'));
  assert.ok(text.includes('qwen-vl-plus'));
  assert.ok(text.includes('视觉 ✓'));
});

test('describeModelProfile：直接描述某一 profile（doctor 用）', () => {
  const info = describeModelProfile('vision', envWith({ LLM_VISION_PROVIDER: 'openai', LLM_VISION_MODEL: 'gpt-4o-mini', LLM_API_KEY: 'sk' }));
  assert.equal(info.configured, true);
  assert.equal(info.supportsVision, true);
  assert.equal(info.model, 'gpt-4o-mini');
});

test('router：单 Key 方案（DeepSeek-Flash 同时做文本与视觉）', () => {
  // 2026-10 复核：deepseek-flash 支持 Vision → 用户只配一个 Key 就能同时用两条链路
  const router = createModelRouter(
    envWith({
      LLM_PROVIDER: 'deepseek',
      LLM_API_KEY: 'sk-same',
      LLM_MODEL: 'deepseek-flash',
      LLM_VISION_PROVIDER: 'deepseek',
      LLM_VISION_MODEL: 'deepseek-flash',
    }),
    { skipProbe: true },
  );
  assert.ok(router.vision);
  assert.equal(router.info.vision.supportsVision, true);
  assert.equal(router.info.text.supportsVision, true, 'deepseek-flash 文本 profile 也能读图');
  assert.equal(router.info.vision.hasCredential, true);
});

test('router：DeepSeek 文本模型（deepseek-chat）仍判为不可读图', () => {
  const info = describeModelProfile('vision', envWith({ LLM_VISION_PROVIDER: 'deepseek', LLM_VISION_MODEL: 'deepseek-chat', LLM_API_KEY: 'sk' }));
  assert.equal(info.supportsVision, false);
  assert.ok((info.suggestions ?? []).some((item) => item.includes('deepseek-flash')));
});
