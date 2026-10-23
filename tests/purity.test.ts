import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { bareFetchLines, formatPurityReport, importSpecifiers, scanPurity, vendorOf } from '../scripts/lib/purity.mjs';

const repoRoot = process.cwd();
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'purity');

test('importSpecifiers：覆盖 import / 动态 import / require / export from', () => {
  const source = [
    "import OpenAI from 'openai';",
    "import { x } from './local.ts';",
    "const y = await import('@anthropic-ai/sdk');",
    "const z = require('dashscope');",
    "export { a } from 'ollama';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), ['openai', './local.ts', '@anthropic-ai/sdk', 'dashscope', 'ollama']);
});

test('vendorOf：识别厂商 SDK 及其子路径，放行相对路径与 node: 内置模块', () => {
  assert.equal(vendorOf('openai'), 'openai');
  assert.equal(vendorOf('openai/resources'), 'openai');
  assert.equal(vendorOf('@anthropic-ai/sdk'), '@anthropic-ai/sdk');
  assert.equal(vendorOf('@ai-sdk/openai'), null, '未列入名单的包不算违规（由 ESLint 规则兜底）');
  assert.equal(vendorOf('./local.ts'), null);
  assert.equal(vendorOf('node:fs'), null);
});

test('bareFetchLines：识别裸 fetch，但忽略注释与成员调用（如 this.fetch、opts.fetchImpl）', () => {
  const source = [
    'const a = fetch("https://x");',
    '  // fetch("https://commented");',
    'const b = this.fetch("x");',
    'const c = opts.fetchImpl("x");',
    '* fetch("inside jsdoc")',
  ].join('\n');
  assert.deepEqual(bareFetchLines(source), [1]);
});

test('扫描夹具（反向验证）：违规文件被抓出，合规文件不被误报', async () => {
  const result = await scanPurity({
    root: fixtureRoot,
    businessDirs: ['bad-business', 'good-business'],
    allowedDirs: [],
  });

  assert.equal(result.scanned, 3, '夹具目录共 3 个文件');
  assert.equal(result.missingDirs.length, 0);

  const violationFiles = result.violations.map((v) => v.file).sort();
  assert.deepEqual(violationFiles, ['bad-business/vendor-sdk.ts'], '只应抓出直接引用 SDK 的文件');
  assert.match(result.violations[0]!.detail, /openai/);

  const warningFiles = result.warnings.map((w) => w.file).sort();
  assert.deepEqual(warningFiles, ['bad-business/bare-fetch.ts'], '裸 fetch 应作为警告报出');

  const report = formatPurityReport(result);
  assert.equal(report.ok, false);
  assert.match(report.text, /❌ 发现 1 处违规/);
});

test('扫描夹具：白名单目录被放行（模拟 src/lib/llm）', async () => {
  const result = await scanPurity({
    root: fixtureRoot,
    businessDirs: ['bad-business'],
    allowedDirs: ['bad-business'],
  });
  assert.equal(result.scanned, 0, '整个目录在白名单内时应跳过');
  assert.equal(result.violations.length, 0);
});

test('扫描真实仓库：业务目录（若存在）零厂商 SDK 引用，并报告尚未创建的目录', async () => {
  const result = await scanPurity({ root: repoRoot });
  const report = formatPurityReport(result);

  assert.equal(result.violations.length, 0, `发现违规：${JSON.stringify(result.violations)}`);
  assert.equal(report.ok, true);
  // 尚未创建的业务目录必须是"显式报告"而不是静默跳过，避免假绿
  assert.ok(Array.isArray(result.missingDirs));
  if (result.missingDirs.length > 0) {
    assert.match(report.text, /尚未创建的业务目录/);
  }
});

test('formatPurityReport：通过时给出明确结论与扫描规模', async () => {
  const result = await scanPurity({ root: fixtureRoot, businessDirs: ['good-business'], allowedDirs: [] });
  const report = formatPurityReport(result);
  assert.equal(report.ok, true);
  assert.match(report.text, /扫描文件: 1 个/);
  assert.match(report.text, /✅ 通过/);
});
