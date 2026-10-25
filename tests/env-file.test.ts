import test from 'node:test';
import assert from 'node:assert/strict';

import { applyMissingEnvKeys, collectMissingEnvKeys } from '../src/lib/server/env-file.ts';

const TEMPLATE = [
  '# 数据库',
  'DATABASE_URL=postgresql://localhost/postgres',
  '',
  '# ---------- 视觉模型（可选）----------',
  '# 不配置时截图识别不可用',
  'LLM_VISION_PROVIDER=',
  'LLM_VISION_MODEL=',
  '# 留空 = 继承 LLM_API_KEY',
  'LLM_VISION_API_KEY=',
  '',
  '# 工作区',
  'WORKSPACE_DIR=./data/workspace',
].join('\n');

test('collectMissingEnvKeys：只列出当前文件没有的键', () => {
  const current = 'DATABASE_URL=postgresql://real/db\nLLM_VISION_PROVIDER=qwen\n';
  const missing = collectMissingEnvKeys(current, TEMPLATE);
  assert.deepEqual(
    missing.map((item) => item.key),
    ['LLM_VISION_MODEL', 'LLM_VISION_API_KEY', 'WORKSPACE_DIR'],
  );
  // 注释块只带"紧邻上方"的注释：LLM_VISION_MODEL 上一行是赋值行 → 没有注释
  assert.deepEqual(missing[0]!.comment, []);
  // WORKSPACE_DIR 上方紧邻 '# 工作区' → 应带上
  assert.deepEqual(missing[2]!.comment, ['# 工作区']);
  assert.equal(missing[2]!.line, 'WORKSPACE_DIR=./data/workspace');
});

test('collectMissingEnvKeys：已有键即使值为空也不算缺失', () => {
  const current = 'DATABASE_URL=x\nLLM_VISION_PROVIDER=\nLLM_VISION_MODEL=\nLLM_VISION_API_KEY=\nWORKSPACE_DIR=\n';
  assert.deepEqual(collectMissingEnvKeys(current, TEMPLATE), []);
});

test('applyMissingEnvKeys：追加带注释的缺失键，且保留原有内容', () => {
  const current = 'DATABASE_URL=postgresql://real/db\nLLM_API_KEY=sk-real-secret\n';
  const { text, added } = applyMissingEnvKeys(current, TEMPLATE);

  assert.deepEqual(added, ['LLM_VISION_PROVIDER', 'LLM_VISION_MODEL', 'LLM_VISION_API_KEY', 'WORKSPACE_DIR']);
  assert.ok(text.includes('DATABASE_URL=postgresql://real/db'), '不得改动已有值');
  assert.ok(text.includes('LLM_API_KEY=sk-real-secret'), '不得改动已有密钥');
  assert.ok(text.includes('# ---------- 视觉模型（可选）----------'), '应带上注释块');
  assert.ok(text.includes('LLM_VISION_PROVIDER='));
  assert.ok(text.includes('由 setup 从 .env.example 自动补齐'), '应有分组标题');
});

test('applyMissingEnvKeys：幂等（第二次调用不产生变化）', () => {
  const first = applyMissingEnvKeys('DATABASE_URL=x\n', TEMPLATE);
  const second = applyMissingEnvKeys(first.text, TEMPLATE);
  assert.deepEqual(second.added, []);
  assert.equal(second.text, first.text);
});

test('applyMissingEnvKeys：全部键都在时原样返回', () => {
  const { text, added } = applyMissingEnvKeys(TEMPLATE, TEMPLATE);
  assert.deepEqual(added, []);
  assert.equal(text, TEMPLATE);
});
