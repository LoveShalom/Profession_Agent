import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_TTL_MS,
  capabilitiesFromPreset,
  createMemoryCapabilitiesStore,
  describeCapabilities,
  isContextSufficient,
  mergeCapabilities,
  resolveCapabilities,
} from '../src/lib/llm/capabilities.ts';
import { PROVIDER_PRESETS } from '../src/lib/llm/registry.ts';
import { createOpenAICompatibleAdapter } from '../src/lib/llm/openai-compatible.ts';
import type { Capabilities, ProviderConfig, ProviderAdapter, ProbeResult } from '../src/lib/llm/types.ts';

const DEEPSEEK = PROVIDER_PRESETS.find((p) => p.name === 'deepseek')!;

const config: ProviderConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  model: 'deepseek-chat',
  timeoutMs: 50,
  maxRetries: 0,
  allowPrivateBaseUrl: false,
};

function adapterReturning(probe: ProbeResult): ProviderAdapter {
  const base = createOpenAICompatibleAdapter(config, { sleep: async () => {}, now: () => 0 });
  return { ...base, probe: async () => probe };
}

test('内存缓存：set / get / invalidate（单条与全部）', () => {
  const store = createMemoryCapabilitiesStore();
  const caps = capabilitiesFromPreset(DEEPSEEK);
  store.set({ provider: 'deepseek', model: 'deepseek-chat', capabilities: caps, probedAt: 1000 });
  store.set({ provider: 'qwen', model: 'qwen-plus', capabilities: caps, probedAt: 1000 });

  assert.equal(store.get('deepseek', 'deepseek-chat')?.probedAt, 1000);
  assert.equal(store.get('qwen', 'qwen-plus')?.model, 'qwen-plus');

  store.invalidate('deepseek');
  assert.equal(store.get('deepseek', 'deepseek-chat'), undefined);
  assert.ok(store.get('qwen', 'qwen-plus'));

  store.invalidate();
  assert.equal(store.get('qwen', 'qwen-plus'), undefined);
});

test('capabilitiesFromPreset：来源标记为 default', () => {
  const caps = capabilitiesFromPreset(DEEPSEEK);
  assert.equal(caps.source, 'default');
  assert.equal(caps.tool_calling, DEEPSEEK.defaults.tool_calling);
});

test('mergeCapabilities：声明值覆盖预设，来源变为 declared', () => {
  const base = capabilitiesFromPreset(DEEPSEEK);
  const merged = mergeCapabilities(base, { tool_calling: false, context_window: 8192 });
  assert.equal(merged.tool_calling, false);
  assert.equal(merged.context_window, 8192);
  assert.equal(merged.embedding, base.embedding, '未声明的字段保留预设值');
  assert.equal(merged.source, 'declared');
});

test('resolveCapabilities：缓存未过期时不探测', async () => {
  const store = createMemoryCapabilitiesStore();
  const fallback = capabilitiesFromPreset(DEEPSEEK);
  store.set({ provider: 'deepseek', model: 'deepseek-chat', capabilities: fallback, probedAt: 1000 });

  let probeCalls = 0;
  const adapter = adapterReturning({ ok: true, latencyMs: 1, capabilities: fallback });
  const spy: ProviderAdapter = { ...adapter, probe: async () => { probeCalls += 1; return { ok: true, latencyMs: 1, capabilities: fallback }; } };

  const result = await resolveCapabilities({
    adapter: spy,
    store,
    provider: 'deepseek',
    model: 'deepseek-chat',
    fallback,
    now: () => 1000 + CAPABILITY_TTL_MS - 1,
  });
  assert.equal(result.probed, false);
  assert.equal(probeCalls, 0);
});

test('resolveCapabilities：缓存过期后重新探测并刷新时间戳', async () => {
  const store = createMemoryCapabilitiesStore();
  const fallback = capabilitiesFromPreset(DEEPSEEK);
  store.set({ provider: 'deepseek', model: 'deepseek-chat', capabilities: fallback, probedAt: 1000 });

  const probed: Capabilities = { ...fallback, tool_calling: false, source: 'probe' };
  const adapter = adapterReturning({ ok: true, latencyMs: 5, capabilities: probed });

  const result = await resolveCapabilities({
    adapter,
    store,
    provider: 'deepseek',
    model: 'deepseek-chat',
    fallback,
    now: () => 1000 + CAPABILITY_TTL_MS + 1,
  });
  assert.equal(result.probed, true);
  assert.equal(result.capabilities.tool_calling, false);
  assert.equal(result.capabilities.source, 'probe');
  assert.equal(store.get('deepseek', 'deepseek-chat')?.probedAt, 1000 + CAPABILITY_TTL_MS + 1);
});

test('resolveCapabilities：探测失败时回退到预设值并返回原因（不抛错）', async () => {
  const store = createMemoryCapabilitiesStore();
  const fallback = capabilitiesFromPreset(DEEPSEEK);
  const adapter = adapterReturning({ ok: false, latencyMs: 20, capabilities: fallback, detail: 'Key 无效' });

  const result = await resolveCapabilities({ adapter, store, provider: 'deepseek', model: 'deepseek-chat', fallback, now: () => 5000 });
  assert.equal(result.probed, true);
  assert.equal(result.capabilities.source, 'default');
  assert.equal(result.probeDetail, 'Key 无效');
  assert.equal(store.get('deepseek', 'deepseek-chat'), undefined, '失败不应写入缓存');
});

test('resolveCapabilities：skipProbe（离线 / doctor --no-network）直接用回退值', async () => {
  const store = createMemoryCapabilitiesStore();
  const fallback = capabilitiesFromPreset(DEEPSEEK);
  let probeCalls = 0;
  const adapter: ProviderAdapter = {
    ...createOpenAICompatibleAdapter(config, { sleep: async () => {}, now: () => 0 }),
    probe: async () => { probeCalls += 1; return { ok: true, latencyMs: 1, capabilities: fallback }; },
  };
  const result = await resolveCapabilities({
    adapter,
    store,
    provider: 'deepseek',
    model: 'deepseek-chat',
    fallback,
    skipProbe: true,
  });
  assert.equal(result.probed, false);
  assert.equal(probeCalls, 0);
});

test('describeCapabilities：人可读摘要包含来源与关键能力', () => {
  const text = describeCapabilities({ ...capabilitiesFromPreset(DEEPSEEK), source: 'probe' });
  assert.match(text, /tool_calling ✓/);
  assert.match(text, /source=probe/);
  assert.match(text, /context 65536/);
});

test('isContextSufficient：窗口未知时不拦截；窗口不足时判为需要分段', () => {
  const caps = capabilitiesFromPreset(DEEPSEEK);
  assert.equal(isContextSufficient({ ...caps, context_window: 0 }, 100_000), true);
  assert.equal(isContextSufficient(caps, 10_000), true);
  assert.equal(isContextSufficient(caps, caps.context_window), false);
});
