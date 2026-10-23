/**
 * 零 spawn 的测试运行器（I0 / T1）
 *
 * 为什么不用 `node --test tests/`：该模式下 Node 会为每个测试文件 spawn 子进程并
 * 通过管道收集输出（stdio: 'pipe'），在受限沙箱里会直接 EPERM。本运行器改为在
 * **同一进程内**依次动态 import 所有测试文件，由 node:test 的默认运行器执行。
 *
 * 用法：node scripts/run-tests.mjs [--filter=xxx]
 * 退出码：0 全部通过；1 有失败；2 未找到测试文件。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_DIR = path.resolve('tests');
const filterArg = process.argv.find((a) => a.startsWith('--filter='));
const filter = filterArg ? filterArg.slice('--filter='.length) : '';

async function main() {
  let entries = [];
  try {
    entries = await readdir(TEST_DIR);
  } catch {
    console.error(`✖ 找不到测试目录：${TEST_DIR}`);
    process.exit(2);
  }

  const files = entries.filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.mjs')).sort();
  const selected = filter ? files.filter((f) => f.includes(filter)) : files;

  if (selected.length === 0) {
    console.error(`✖ 没有匹配的测试文件（目录：${TEST_DIR}，过滤器："${filter}"）`);
    process.exit(2);
  }

  console.log(`▶ 运行 ${selected.length} 个测试文件：${selected.join(', ')}\n`);
  for (const file of selected) {
    await import(pathToFileURL(path.join(TEST_DIR, file)).href);
  }
}

await main();
