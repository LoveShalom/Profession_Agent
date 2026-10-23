import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertEnv,
  describeEnv,
  ENV_SPEC,
  EnvValidationError,
  formatEnvIssues,
  generateEncryptionKey,
  isEncryptionKey,
  validateEnv,
} from '../src/lib/env.ts';

const KEY = generateEncryptionKey();
const base = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres', ENCRYPTION_KEY: KEY };

test('缺必填项时：ok=false，且同时列出全部缺失项', () => {
  const result = validateEnv({});
  assert.equal(result.ok, false);
  const keys = result.issues.filter((i) => i.severity === 'error').map((i) => i.key).sort();
  assert.deepEqual(keys, ['DATABASE_URL', 'ENCRYPTION_KEY']);
});

test('合法输入：应用默认值并通过', () => {
  const result = validateEnv({ ...base });
  assert.equal(result.ok, true);
  const env = result.env!;
  assert.equal(env.llmProvider, 'deepseek');
  assert.equal(env.sampleK, 3);
  assert.equal(env.enableAuth, false);
  assert.equal(env.allowPrivateBaseUrl, false);
  assert.equal(env.port, 3000);
  assert.equal(env.appUrl, 'http://localhost:3000');
  assert.deepEqual(env.egressExtraHosts, []);
});

test('非法输入：一次性列出所有错误（不是遇到第一个就停）', () => {
  const result = validateEnv({
    ...base,
    ENCRYPTION_KEY: 'tooshort',
    LLM_PROVIDER: 'not-a-provider',
    LLM_SAMPLE_K: '9',
    APP_PORT: 'abc',
  } satisfies Record<string, string>);
  assert.equal(result.ok, false);
  const keys = result.issues.filter((i) => i.severity === 'error').map((i) => i.key).sort();
  assert.deepEqual(keys, ['APP_PORT', 'ENCRYPTION_KEY', 'LLM_PROVIDER', 'LLM_SAMPLE_K']);
});

test('疑似拼错的键名只给 warning，不阻断启动（如 LLM_MODEL_EXRACT）', () => {
  const result = validateEnv({ ...base, LLM_MODEL_EXRACT: 'deepseek-chat' });
  assert.equal(result.ok, true);
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.key, 'LLM_MODEL_EXRACT');
  assert.equal(warnings[0]!.code, 'unknown');
});

test('布尔字段接受多种写法', () => {
  for (const v of ['true', '1', 'yes', 'ON']) {
    assert.equal(validateEnv({ ...base, ENABLE_AUTH: v }).env!.enableAuth, true, `ENABLE_AUTH=${v}`);
  }
  for (const v of ['false', '0', 'no', 'off', '']) {
    assert.equal(validateEnv({ ...base, ENABLE_AUTH: v }).env!.enableAuth, false, `ENABLE_AUTH=${v}`);
  }
  const bad = validateEnv({ ...base, ENABLE_AUTH: 'maybe' });
  assert.equal(bad.ok, false);
  assert.match(bad.issues[0]!.message, /不是布尔值/);
});

test('URL 字段只接受 http/https', () => {
  assert.equal(validateEnv({ ...base, LLM_BASE_URL: 'https://api.deepseek.com/v1' }).ok, true);
  assert.equal(validateEnv({ ...base, LLM_BASE_URL: 'http://127.0.0.1:11434/v1' }).ok, true);
  const ftp = validateEnv({ ...base, LLM_BASE_URL: 'ftp://example.com' });
  assert.equal(ftp.ok, false);
  assert.match(ftp.issues[0]!.message, /仅支持 http\/https/);
});

test('DATABASE_URL 必须是 postgres 协议', () => {
  const bad = validateEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' });
  assert.equal(bad.ok, false);
  assert.match(bad.issues[0]!.message, /postgres/);
});

test('ENCRYPTION_KEY：必须是 base64 的 32 字节', () => {
  assert.equal(isEncryptionKey(KEY), true);
  assert.equal(isEncryptionKey(''), false);
  assert.equal(isEncryptionKey('abc'), false);
  assert.equal(isEncryptionKey(Buffer.from('short').toString('base64')), false);
  // 生成 100 个都合法
  for (let i = 0; i < 100; i += 1) assert.equal(isEncryptionKey(generateEncryptionKey()), true);
});

test('LLM_SAMPLE_K 有范围限制（1–5，整数）', () => {
  assert.equal(validateEnv({ ...base, LLM_SAMPLE_K: '1' }).ok, true);
  assert.equal(validateEnv({ ...base, LLM_SAMPLE_K: '5' }).ok, true);
  assert.equal(validateEnv({ ...base, LLM_SAMPLE_K: '0' }).ok, false);
  assert.equal(validateEnv({ ...base, LLM_SAMPLE_K: '6' }).ok, false);
  assert.equal(validateEnv({ ...base, LLM_SAMPLE_K: '2.5' }).ok, false);
});

test('EGRESS_EXTRA_HOSTS 解析为去空数组', () => {
  const env = validateEnv({ ...base, EGRESS_EXTRA_HOSTS: ' a.example.com , ,b.example.com ' }).env!;
  assert.deepEqual(env.egressExtraHosts, ['a.example.com', 'b.example.com']);
});

test('assertEnv：失败时抛出包含全部非法项的错误', () => {
  assert.throws(
    () => assertEnv({}),
    (error: unknown) => {
      assert.ok(error instanceof EnvValidationError);
      assert.equal(error.issues.filter((i) => i.severity === 'error').length, 2);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /ENCRYPTION_KEY/);
      return true;
    },
  );
});

test('formatEnvIssues：通过时给出成功文案', () => {
  assert.match(formatEnvIssues([]), /校验通过/);
  assert.match(formatEnvIssues(validateEnv({}).issues), /必填项缺失/);
});

test('describeEnv：不回显任何密钥明文', () => {
  const env = validateEnv({
    ...base,
    LLM_API_KEY: 'sk-supersecret-1234567890',
    LANGFUSE_SECRET_KEY: 'lf-secret-abcdefghij',
  }).env!;
  const text = describeEnv(env);
  assert.equal(text.includes('sk-supersecret'), false);
  assert.equal(text.includes('lf-secret'), false);
  assert.match(text, /"hasApiKey": true/);
});

test('ENV_SPEC 自身一致：键名唯一，默认值都能通过校验', () => {
  const keys = ENV_SPEC.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, '存在重复键名');
  for (const spec of ENV_SPEC) {
    if (spec.default === undefined) continue;
    if (spec.key === 'DATABASE_URL' || spec.key === 'ENCRYPTION_KEY') continue;
    const result = validateEnv({ ...base, [spec.key]: spec.default });
    assert.equal(result.ok, true, `${spec.key} 的默认值未通过校验`);
  }
});
