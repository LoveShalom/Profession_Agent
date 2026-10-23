#!/usr/bin/env node
/**
 * 适配层纯净度检查 CLI（I0 / T6，AC-13 与红线③）
 *
 * 为什么需要脚本而不只靠 ESLint：ESLint 需要联网安装依赖，而这条红线必须在任何环境
 * （CI、离线、review 前）都能验证。扫描逻辑在 scripts/lib/purity.mjs，便于被测试夹具验证。
 *
 * 用法：node scripts/check-adapter-purity.mjs [--verbose]
 * 退出码：0 通过；1 存在违规
 */

import { formatPurityReport, scanPurity } from './lib/purity.mjs';

const verbose = process.argv.includes('--verbose');
const result = await scanPurity({ root: process.cwd() });
const report = formatPurityReport(result);

console.log(report.text);
if (verbose && report.ok) {
  console.log('\n（--verbose）提示：该检查同时被 tests/purity.test.ts 用违规夹具反向验证，避免真空通过。');
}
process.exit(report.ok ? 0 : 1);
