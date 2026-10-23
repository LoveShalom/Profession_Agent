/**
 * 适配层纯净度扫描（可测试的纯逻辑，供 CLI 与测试共用）
 *
 * 规则：
 *   ❌ 业务目录里出现厂商 SDK 的 import/require  → 违规（红线③）
 *   ⚠️ 业务目录里出现裸 fetch( 调用              → 警告（网络出口应经适配层）
 *
 * 设计上特意把"扫描函数"与"命令行输出"分开，这样测试可以直接构造违规夹具验证"检查确实有效"，
 * 避免出现"因为目录不存在而真空通过"的假绿。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const VENDOR_SDKS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  'cohere-ai',
  'dashscope',
  'ollama',
];

/** 允许直接引用厂商 SDK 的目录（前缀匹配，相对 root） */
export const DEFAULT_ALLOWED_DIRS = ['src/lib/llm', 'scripts', 'tests'];

export const DEFAULT_BUSINESS_DIRS = [
  'src/app',
  'src/server',
  'src/components',
  'src/lib/pipeline',
  'src/lib/scoring',
  'src/lib/state-machine',
];

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.data']);

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, extensions) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(full, extensions)));
    } else if (extensions.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** 抽出所有 import/require/export-from 的说明符 */
export function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    /(?:^|\s)import\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
    /(?:^|\s)import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\s)require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\s)export\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

export function vendorOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('/')) return null;
  return VENDOR_SDKS.find((sdk) => spec === sdk || spec.startsWith(`${sdk}/`)) ?? null;
}

/** 找出裸 fetch( 调用所在行号（排除注释行） */
export function bareFetchLines(source) {
  return source
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /(^|[^.\w])fetch\s*\(/.test(line))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .map(({ number }) => number);
}

/**
 * 扫描纯净度。
 * @returns violations 违规（阻断）；warnings 警告；scanned 扫描文件数；missingDirs 不存在的业务目录
 */
export async function scanPurity(options = {}) {
  const root = options.root ?? process.cwd();
  const businessDirs = options.businessDirs ?? DEFAULT_BUSINESS_DIRS;
  const allowedDirs = options.allowedDirs ?? DEFAULT_ALLOWED_DIRS;
  const extensions = options.extensions ?? CODE_EXT;

  const violations = [];
  const warnings = [];
  const missingDirs = [];
  let scanned = 0;

  for (const dir of businessDirs) {
    const absolute = path.join(root, dir);
    if (!(await exists(absolute))) {
      missingDirs.push(dir);
      continue;
    }
    for (const file of await walk(absolute, extensions)) {
      const relative = toPosix(path.relative(root, file));
      if (allowedDirs.some((allowed) => relative === allowed || relative.startsWith(`${allowed}/`))) continue;
      scanned += 1;
      const source = await readFile(file, 'utf8');

      for (const spec of importSpecifiers(source)) {
        const sdk = vendorOf(spec);
        if (sdk) violations.push({ file: relative, detail: `直接引用厂商 SDK「${spec}」` });
      }
      for (const lineNumber of bareFetchLines(source)) {
        warnings.push({ file: relative, detail: `第 ${lineNumber} 行出现裸 fetch( 调用` });
      }
    }
  }

  return { violations, warnings, scanned, missingDirs, businessDirs, allowedDirs };
}

export function formatPurityReport(result) {
  const lines = [];
  lines.push('▶ 适配层纯净度检查（AC-13 / 红线③）');
  lines.push(`  业务目录: ${result.businessDirs.join(', ')}`);
  lines.push(`  扫描文件: ${result.scanned} 个`);
  lines.push(`  允许直接引用厂商 SDK: ${result.allowedDirs.join(', ')}`);
  if (result.missingDirs.length > 0) {
    lines.push(`  ⚠️ 尚未创建的业务目录: ${result.missingDirs.join(', ')}（对应功能落地后自动纳入扫描）`);
  }
  lines.push('');
  if (result.warnings.length > 0) {
    lines.push(`⚠️  警告 ${result.warnings.length} 处（不阻断）：`);
    for (const w of result.warnings) lines.push(`   - ${w.file}: ${w.detail}`);
    lines.push('');
  }
  if (result.violations.length > 0) {
    lines.push(`❌ 发现 ${result.violations.length} 处违规：`);
    for (const v of result.violations) lines.push(`   - ${v.file}: ${v.detail}`);
    lines.push('');
    lines.push('修复方式：把模型调用改为经 src/lib/llm（Provider 适配层）；新增 provider 请改 registry.ts。');
    return { ok: false, text: lines.join('\n') };
  }
  lines.push('✅ 通过：业务代码零厂商 SDK 引用');
  return { ok: true, text: lines.join('\n') };
}
