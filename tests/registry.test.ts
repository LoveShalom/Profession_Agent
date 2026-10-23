import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderError } from '../src/lib/errors.ts';
import { allowedEgressHosts, PROVIDER_PRESETS, resolveProvider, resolveTaskModel } from '../src/lib/llm/registry.ts';

test('预设 provider：解析出内置地址与默认模型', () => {
  for (const preset of PROVIDER_PRESETS) {
    const resolved = resolveProvider({ provider: preset.name, allowPrivateBaseUrl: false });
    assert.equal(resolved.baseUrl, preset.baseUrl.replace(/\/+$/, ''), preset.name);
    assert.equal(resolved.model, preset.defaultModel, preset.name);
    assert.equal(resolved.baseUrlOverridden, false);
  }
});

test('显式覆盖：baseUrl / model 以用户配置为准，且去掉尾部斜杠', () => {
  const resolved = resolveProvider({
    provider: 'deepseek',
    baseUrl: 'https://gateway.example.com/v1///',
    model: 'my-model',
    allowPrivateBaseUrl: false,
  });
  assert.equal(resolved.baseUrl, 'https://gateway.example.com/v1');
  assert.equal(resolved.model, 'my-model');
  assert.equal(resolved.baseUrlOverridden, true);
  assert.equal(resolved.modelOverridden, true);
});

test('custom provider：必须同时给出 base_url 与 model', () => {
  assert.throws(
    () => resolveProvider({ provider: 'custom', allowPrivateBaseUrl: false }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'config');
      assert.match(error.userHint, /LLM_BASE_URL/);
      return true;
    },
  );
  assert.throws(() => resolveProvider({ provider: 'custom', baseUrl: 'https://x.example.com/v1', allowPrivateBaseUrl: false }),
    /LLM_MODEL/);
});

test('未知 provider：报错并列出全部可选值', () => {
  assert.throws(
    () => resolveProvider({ provider: 'gpt5', allowPrivateBaseUrl: false }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'config');
      assert.match(error.userHint, /deepseek/);
      assert.match(error.userHint, /custom/);
      return true;
    },
  );
});

test('provider 名称大小写与空白容错', () => {
  assert.equal(resolveProvider({ provider: '  DeepSeek ', allowPrivateBaseUrl: false }).preset.name, 'deepseek');
});

test('出站白名单：去重、小写归一、包含遥测与额外域名', () => {
  const hosts = allowedEgressHosts({
    providerBaseUrl: 'https://API.DeepSeek.com/v1',
    extraHosts: ['Extra.Example.com', 'api.deepseek.com'],
    telemetryHost: 'cloud.langfuse.com',
  });
  assert.deepEqual(hosts, ['api.deepseek.com', 'cloud.langfuse.com', 'extra.example.com']);
});

test('出站白名单：不像主机名的裸词被忽略（防用户误填）', () => {
  const hosts = allowedEgressHosts({ providerBaseUrl: 'not-a-url', extraHosts: ['ok.example.com', 'garbage'] });
  assert.deepEqual(hosts, ['ok.example.com']);
});

test('出站白名单：localhost 与 IP 字面量被视为合法主机名', () => {
  assert.deepEqual(allowedEgressHosts({ providerBaseUrl: 'http://localhost:11434/v1' }), ['localhost']);
  assert.deepEqual(allowedEgressHosts({ providerBaseUrl: 'http://127.0.0.1:11434/v1' }), ['127.0.0.1']);
});

test('任务级模型偏好：extract / generate / embed 各自回退到主模型', () => {
  const base = { model: 'main-model', modelExtract: 'cheap-model', embeddingModel: 'bge-m3' };
  assert.equal(resolveTaskModel({ ...base, task: 'extract' }), 'cheap-model');
  assert.equal(resolveTaskModel({ ...base, task: 'generate' }), 'main-model');
  assert.equal(resolveTaskModel({ ...base, task: 'embed' }), 'bge-m3');
  assert.equal(resolveTaskModel({ model: 'main-model', task: 'extract' }), 'main-model');
});

test('Ollama 预设：标记为私网且允许无 Key', () => {
  const ollama = PROVIDER_PRESETS.find((p) => p.name === 'ollama');
  assert.ok(ollama);
  assert.equal(ollama.privateByDefault, true);
  assert.equal(ollama.keyOptional, true);
});
