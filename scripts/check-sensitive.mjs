#!/usr/bin/env node
/**
 * 敏感文件拦截（提交前检查）
 *
 * 为什么需要：`.gitignore` 只能挡住"从没被跟踪过"的文件。它挡不住：
 *   · `git add -f` 强加；
 *   · 已经 `git add` 进暂存区的文件（此时 .gitignore 不再生效）；
 *   · 路径规则写错（比如本项目真的踩过：`.data/` 而不是 `data/`）。
 * 所以在 pre-commit 再加一道"按内容与路径扫描暂存区"的闸门。
 *
 * 用法：
 *   node scripts/check-sensitive.mjs            # 检查暂存区（pre-commit 自动调用）
 *   node scripts/check-sensitive.mjs --all      # 检查整个工作区（可选）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const scanAll = argv.includes('--all');

const BLOCKED_PATH = [
  /(^|\/)\.env($|\.)/, // .env / .env.local / .env.production
  /(^|\/)data\//, // 本地数据（台账/原始JD/简历/附件）
  /(^|\/)\.data\//,
  /原始JD\//,
  /\.(pem|key|p12|keystore)$/i,
  /id_rsa/,
  /credentials.*\.json$/i,
  /\.(sqlite|dump)$/i,
];

/** 允许例外：模板与测试夹具 */
const ALLOWED = [/^\.env\.example$/, /^tests\//, /^\.gitkeep$/];

/**
 * 内容扫描跳过目录：测试与脚本里有**故意构造的假密钥/假身份证**（`sk-test-...`），
 * 对它们做内容扫描只会产生噪音。路径规则仍然生效（那才是真风险）。
 */
const CONTENT_SCAN_SKIP = [/^tests\//, /^scripts\//, /^docs\//, /^spec\//, /^logs\//];

/** 假数据特征：命中行里出现这些词就不算泄露 */
const FAKE_MARKERS = /(test|fake|demo|example|sample|placeholder|dummy|xxx|your[-_ ]?key|sk-test|示例|假)/i;

/** 内容特征：真实密钥 / 身份证 / 手机号密集出现 */
const CONTENT_RULES = [
  { label: '疑似 API Key（sk-... / AIza... / ghp_...）', pattern: /\b(sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,})\b/ },
  { label: '疑似私钥块', pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: '疑似中国身份证号', pattern: /\b[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/ },
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const files = scanAll
  ? git(['ls-files', '-z']).split('\0').filter(Boolean)
  : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);

if (files.length === 0) {
  console.log('✅ 没有待检查的文件');
  process.exit(0);
}

const problems = [];
for (const file of files) {
  if (ALLOWED.some((pattern) => pattern.test(file))) continue;

  const pathHit = BLOCKED_PATH.find((pattern) => pattern.test(file));
  if (pathHit) {
    problems.push({ file, reason: '路径命中敏感规则（本地数据 / 环境变量 / 密钥）' });
    continue;
  }

  // 只看文本类文件的内容（二进制跳过）
  if (/\.(png|jpe?g|webp|gif|pdf|docx|xlsx|zip|gz|woff2?)$/i.test(file)) continue;
  if (CONTENT_SCAN_SKIP.some((pattern) => pattern.test(file))) continue;
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.length > 512 * 1024) text = text.slice(0, 512 * 1024);
  const contentHit = CONTENT_RULES.find((rule) => {
    const match = rule.pattern.exec(text);
    if (!match) return false;
    // 命中行里带"test/fake/示例"等字样 → 假数据，放过
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd = text.indexOf('\n', match.index);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    return !FAKE_MARKERS.test(line);
  });
  if (contentHit) problems.push({ file, reason: contentHit.label });
}

if (problems.length === 0) {
  console.log(`✅ 提交检查通过（${files.length} 个文件）`);
  process.exit(0);
}

console.error('\n❌ 检测到可能泄露隐私/密钥的文件，已阻止提交：\n');
for (const item of problems) console.error(`   • ${item.file} —— ${item.reason}`);
console.error('\n处理方式：');
console.error('  1) 确认是本地数据 → git restore --staged <file>（保留本地文件）');
console.error('  2) 该路径本应被忽略 → 补 .gitignore 后 git rm --cached <file>');
console.error('  3) 确有需要提交的测试夹具 → 放到 tests/fixtures/ 下（白名单）');
console.error('  4) 真要强推 → 先想清楚：GitHub 上的历史无法真正删除\n');
process.exit(1);
