import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderError } from '../src/lib/errors.ts';
import { assertBaseUrlAllowed, checkBaseUrl, EgressGuard, isPrivateHostname, normalizeHostname } from '../src/lib/llm/guard.ts';

test('isPrivateHostname：私网与本机地址全部识别', () => {
  const privateHosts = [
    'localhost',
    'foo.localhost',
    'api.local',
    'svc.internal',
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
  ];
  for (const host of privateHosts) assert.equal(isPrivateHostname(host), true, `${host} 应判定为私网`);

  const publicHosts = [
    'api.deepseek.com',
    '172.32.0.1',
    '11.0.0.1',
    '8.8.8.8',
    '2001:4860:4860::8888',
    'example.com',
  ];
  for (const host of publicHosts) assert.equal(isPrivateHostname(host), false, `${host} 应判定为公网`);
});

test('normalizeHostname：去括号、小写、去尾点', () => {
  assert.equal(normalizeHostname('[::1]'), '::1');
  assert.equal(normalizeHostname('API.Example.com.'), 'api.example.com');
});

test('checkBaseUrl：公网 https 通过', () => {
  const result = checkBaseUrl('https://api.deepseek.com/v1', { allowPrivate: false });
  assert.equal(result.ok, true);
  assert.equal(result.private, false);
  assert.equal(result.hostname, 'api.deepseek.com');
});

test('checkBaseUrl（AC-8）：私网默认拒绝，且提示如何开启', () => {
  const result = checkBaseUrl('http://127.0.0.1:11434/v1', { allowPrivate: false });
  assert.equal(result.ok, false);
  assert.equal(result.private, true);
  assert.match(result.reason ?? '', /拒绝私网地址/);
  assert.match(result.hint ?? '', /ALLOW_PRIVATE_BASE_URL=true/);
});

test('checkBaseUrl（AC-8）：显式开启后私网放行（Ollama 场景）', () => {
  const result = checkBaseUrl('http://127.0.0.1:11434/v1', { allowPrivate: true });
  assert.equal(result.ok, true);
  assert.equal(result.private, true);
});

test('checkBaseUrl：非 http(s) 协议与非法 URL 被拒', () => {
  assert.equal(checkBaseUrl('ftp://example.com', { allowPrivate: false }).ok, false);
  assert.equal(checkBaseUrl('not-a-url', { allowPrivate: false }).ok, false);
  assert.match(checkBaseUrl('not-a-url', { allowPrivate: false }).hint ?? '', /LLM_BASE_URL/);
});

test('assertBaseUrlAllowed：失败时抛 config 错误并带修复建议', () => {
  assert.throws(
    () => assertBaseUrlAllowed('http://192.168.1.5:8000/v1', { allowPrivate: false }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'config');
      assert.equal(error.shouldDegrade, false);
      return true;
    },
  );
  assert.doesNotThrow(() => assertBaseUrlAllowed('https://api.openai.com/v1', { allowPrivate: false }));
});

test('EgressGuard（AC-10）：白名单内放行，白名单外拒绝并记录', () => {
  const guard = new EgressGuard(['api.deepseek.com'], () => 1000);
  assert.equal(guard.isAllowed('https://api.deepseek.com/v1/chat/completions'), true);
  assert.equal(guard.isAllowed('https://evil.example.com/collect'), false);

  assert.equal(guard.check('https://evil.example.com/collect').allowed, false);
  assert.throws(
    () => guard.assertAllowed('https://evil.example.com/collect'),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'config');
      assert.match(error.userHint, /EGRESS_EXTRA_HOSTS/);
      return true;
    },
  );

  const blocked = guard.blockedAttempts();
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.hostname, 'evil.example.com');
  assert.equal(blocked[0]!.at, 1000);
});

test('EgressGuard：域名归一化（大小写 / 尾点 / 端口不影响）', () => {
  const guard = new EgressGuard(['API.Example.com.']);
  assert.equal(guard.isAllowed('https://api.example.com:443/v1'), true);
  assert.equal(guard.isAllowed('https://API.EXAMPLE.COM/v1'), true);
  assert.deepEqual(guard.allowedHosts, ['api.example.com']);
});

test('EgressGuard：空白名单时拒绝一切（安全默认）', () => {
  const guard = new EgressGuard([]);
  assert.equal(guard.isAllowed('https://api.deepseek.com/v1'), false);
  assert.equal(guard.check('https://api.deepseek.com/v1').reason?.includes('不在出站白名单内'), true);
});
