import test from 'node:test';
import assert from 'node:assert/strict';

import { isProviderError, maskKey, ProviderError, redactSecrets } from '../src/lib/errors.ts';

test('redactSecrets：精确输出（防止"没脱敏却把原文复制一遍"这类回归）', () => {
  const cases: Array<[string, string, string]> = [
    ['sk- 形式', 'key is sk-abcdef1234567890 ok', 'key is *** ok'],
    ['Bearer 头', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'Authorization: Bearer ***'],
    ['JSON 形态', '{"api_key": "abc12345xyz"}', '{"api_key": "***"}'],
    ['URL 形态', '?api_key=abc12345xyz&x=1', '?api_key=***&x=1'],
    ['AWS Key ID', 'aws AKIAIOSFODNN7EXAMPLE end', 'aws *** end'],
    ['Google API Key', 'google AIzaSyA1234567890abcdefghijklmnopqrs end', 'google *** end'],
    [
      'base64 密钥',
      'env ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'env ENCRYPTION_KEY=***',
    ],
  ];
  for (const [name, input, expected] of cases) {
    assert.equal(redactSecrets(input), expected, name);
  }
});

test('redactSecrets：任何一种密钥形态都不允许残留', () => {
  const cases: Array<[string, string]> = [
    ['"api_key": "sk-abcdef1234567890"', 'sk-abcdef1234567890'],
    ['Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    ['token=abc12345xyz', 'abc12345xyz'],
    ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['AIzaSyA1234567890abcdefghijklmnopqrs', 'AIzaSyA1234567890abcdefghijklmnopqrs'],
    ['password=Sup3rS3cret!', 'Sup3rS3cret!'],
    ['ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
    ['Authorization: Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
  ];
  for (const [input, secret] of cases) {
    const out = redactSecrets(input);
    assert.equal(out.includes(secret), false, `残留未脱敏：${input}`);
    assert.match(out, /\*\*\*/, `未产生脱敏标记：${input}`);
  }
});

test('redactSecrets：普通文本原样保留（避免误伤）', () => {
  const text = '岗位：后端开发工程师；城市：上海；薪资 20k-35k';
  assert.equal(redactSecrets(text), text);
});

test('maskKey：只保留后 4 位', () => {
  assert.equal(maskKey('sk-abcdefghijklmnop'), '****mnop');
  assert.equal(maskKey('abcd'), '****');
  assert.equal(maskKey(''), '****');
});

test('auth 错误：不可重试、应降级、带修复建议', () => {
  const error = ProviderError.auth(401);
  assert.equal(error.kind, 'auth');
  assert.equal(error.status, 401);
  assert.equal(error.retryable, false);
  assert.equal(error.shouldDegrade, true);
  assert.match(error.userHint, /API Key/);
  assert.equal(isProviderError(error), true);
});

test('rate_limit 错误：可重试，且提示等待秒数', () => {
  const error = ProviderError.rateLimit(3000);
  assert.equal(error.retryable, true);
  assert.equal(error.status, 429);
  assert.match(error.userHint, /3 秒/);
});

test('unreachable 错误：提示检查地址与私网开关（AC-5）', () => {
  const error = ProviderError.unreachable(new Error('ECONNREFUSED'), 'http://127.0.0.1:11434/v1');
  assert.equal(error.kind, 'unreachable');
  assert.equal(error.shouldDegrade, true);
  assert.match(error.userHint, /127\.0\.0\.1:11434/);
  assert.match(error.userHint, /ALLOW_PRIVATE_BASE_URL/);
});

test('capability 错误：指出缺哪项能力', () => {
  const error = ProviderError.capability('embedding');
  assert.equal(error.missing, 'embedding');
  assert.match(error.userHint, /embedding/);
  assert.equal(error.retryable, false);
});

test('schema 错误：保留原始输出但已脱敏且截断', () => {
  const raw = `not json ${'x'.repeat(1000)} sk-abcdef1234567890`;
  const error = ProviderError.schema(raw, 2);
  assert.equal(error.kind, 'schema');
  assert.equal(error.attempts, 2);
  assert.ok(error.raw !== undefined);
  assert.ok(error.raw.length <= 500);
  assert.equal(error.raw.includes('sk-abcdef1234567890'), false);
});

test('toJSON：可序列化且不含密钥', () => {
  const error = new ProviderError('unreachable', 'boom', { raw: 'sk-abcdef1234567890' });
  const json = JSON.stringify(error.toJSON());
  assert.equal(json.includes('sk-abcdef1234567890'), false);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed['kind'], 'unreachable');
  assert.equal(typeof parsed['hint'], 'string');
});

test('config 错误：可自定义 hint', () => {
  const error = ProviderError.config('私网地址被拒绝', '设置 ALLOW_PRIVATE_BASE_URL=true 后重试');
  assert.equal(error.userHint, '设置 ALLOW_PRIVATE_BASE_URL=true 后重试');
  assert.equal(error.shouldDegrade, false);
});

test('server 错误：5xx 可重试并降级', () => {
  const error = ProviderError.server(503, 'upstream down');
  assert.equal(error.retryable, true);
  assert.equal(error.shouldDegrade, true);
});
