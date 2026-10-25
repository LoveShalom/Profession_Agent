import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCredentialOverrides,
  decryptSecret,
  encryptSecret,
  maskKey,
  type CredentialRole,
} from '../src/lib/credentials/store.ts';
import { generateEncryptionKey, validateEnv } from '../src/lib/env.ts';

const KEY = generateEncryptionKey();

function env() {
  const result = validateEnv({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres',
    ENCRYPTION_KEY: KEY,
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: 'sk-env',
    LLM_MODEL: 'deepseek-chat',
  });
  assert.equal(result.ok, true);
  return result.env!;
}

test('加密往返：AES-256-GCM 解密后与原文一致', () => {
  const payload = encryptSecret('sk-super-secret-key-1234', KEY);
  assert.ok(payload.length > 16);
  assert.equal(decryptSecret(payload, KEY), 'sk-super-secret-key-1234');
});

test('密文中不出现明文片段', () => {
  const payload = encryptSecret('sk-super-secret-key-1234', KEY);
  assert.equal(payload.includes(Buffer.from('super-secret')), false);
});

test('篡改密文会被 GCM 校验拒绝（不会静默解出错误内容）', () => {
  const payload = encryptSecret('sk-x', KEY);
  payload[payload.length - 1] = payload[payload.length - 1]! ^ 0xff;
  assert.throws(() => decryptSecret(payload, KEY));
});

test('主密钥非法时拒绝加密（绝不降级明文）', () => {
  assert.throws(() => encryptSecret('sk-x', 'not-a-32-byte-base64-key'));
});

test('maskKey：只保留尾号 4 位', () => {
  assert.equal(maskKey('sk-abcdef1234'), '1234');
  assert.equal(maskKey('abc'), '••••');
  assert.equal(maskKey(''), '••••');
});

test('applyCredentialOverrides：DB 凭证覆盖 .env，且不改动 process.env', () => {
  const base = env();
  const secrets: Array<{ role: CredentialRole; provider: string; baseUrl: string; model: string; apiKey: string }> = [
    { role: 'text', provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', apiKey: 'sk-db-text' },
    { role: 'vision', provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-plus', apiKey: 'sk-db-vision' },
  ];
  const merged = applyCredentialOverrides(base, secrets);
  assert.equal(merged.llmProvider, 'qwen');
  assert.equal(merged.llmModel, 'qwen-plus');
  assert.equal(merged.llmApiKey, 'sk-db-text');
  assert.equal(merged.llmVisionProvider, 'qwen');
  assert.equal(merged.llmVisionModel, 'qwen-vl-plus');
  assert.equal(base.llmProvider, 'deepseek', '原 env 对象不应被修改');
});

test('applyCredentialOverrides：没有凭证时保持 .env 原样', () => {
  const base = env();
  const merged = applyCredentialOverrides(base, []);
  assert.equal(merged.llmProvider, base.llmProvider);
  assert.equal(merged.llmModel, base.llmModel);
  assert.equal(merged.llmVisionProvider, base.llmVisionProvider);
});
