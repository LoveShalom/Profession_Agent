/**
 * I4 汇总验收器（F-09 / T10）
 *
 * 12 项自动检查，覆盖 I4 的四个出口标准：
 *   ① 评测有基线且可复现   ② CI 门离线可跑  
 *   ③ 一键启动可诊断       ④ 只读 Demo 无写入路径
 *
 * 用法：node scripts/verify-i4.mjs [--report]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const lines = [];
const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass });
  const line = `${pass ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line);
  lines.push(line);
}

// ---------------------------------------------------------------- ① 评测基线
const datasetPath = 'evals/jd/dataset.jsonl';
const lockPath = 'evals/jd/dataset.lock.json';
const baselinePath = 'evals/jd/baseline.json';

check('评测集存在', existsSync(datasetPath));
check('评测集 lock 存在', existsSync(lockPath));
if (existsSync(datasetPath) && existsSync(lockPath)) {
  const text = readFileSync(datasetPath, 'utf8');
  const items = text.split('\n').filter((line) => line.trim().length > 0);
  const hash = createHash('sha256').update(text).digest('hex');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  check('评测集 40 条', items.length === 40, `${items.length} 条`);
  check('评测集未被偷改（sha256 一致）', hash === lock.sha256);
  const hasUnknownTag = items.some((line) => !line.includes('"gold"'));
  check('每条都有 gold 标注', !hasUnknownTag);
}

check('基线文件存在', existsSync(baselinePath));
if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  check('基线宏平均 ≥ 80%（过程门）', Number(baseline.macro) >= 0.8, `${(Number(baseline.macro) * 100).toFixed(1)}%`);
  check('基线可判定退化（含 tolerance 语义）', typeof baseline.mode === 'string' && typeof baseline.datasetSha256 === 'string');
}

// ---------------------------------------------------------------- ② CI 门
const ciPath = '.github/workflows/ci.yml';
check('CI workflow 存在', existsSync(ciPath));
if (existsSync(ciPath)) {
  const ci = readFileSync(ciPath, 'utf8');
  check(
    'CI 含 typecheck / test / eval / 敏感扫描',
    ci.includes('typecheck') && ci.includes('run: npm test') && ci.includes('npm run eval') && ci.includes('check-sensitive'),
  );
  check('CI 离线（不依赖 LLM Key / Docker）', !ci.includes('secrets.LLM_API_KEY') && !ci.includes('docker compose'));
}

// ---------------------------------------------------------------- ③ 一键启动
check('preflight 脚本存在', existsSync('scripts/preflight.mjs'));
check('启动文档存在（docs/getting-started.md）', existsSync('docs/getting-started.md'));
check('README 提到 preflight', readFileSync('README.md', 'utf8').includes('preflight'));

// ---------------------------------------------------------------- ④ 只读 Demo
const samplePath = 'evals/demo/sample.json';
const middlewarePath = 'src/middleware.ts';
check('Demo 样例存在且合法', existsSync(samplePath) && (() => {
  try {
    const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
    return Array.isArray(sample.jobs) && sample.jobs.length >= 5 && Array.isArray(sample.experiences);
  } catch {
    return false;
  }
})());
check('DEMO_MODE 写拦截存在', existsSync(middlewarePath) && readFileSync(middlewarePath, 'utf8').includes('DEMO_MODE'));
check('Demo 样例无真实个人信息', (() => {
  if (!existsSync(samplePath)) return false;
  const text = readFileSync(samplePath, 'utf8');
  return !/[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]/.test(text) && !/1[3-9]\d{9}/.test(text);
})());

// ---------------------------------------------------------------- ⑤ 可观测性（T8/T9）
check('诊断页存在', existsSync('src/app/settings/diagnostics/page.tsx'));
check('用量记账模块存在', existsSync('src/lib/server/usage.ts'));
check('迁移 0007（prompt_version）存在', existsSync('supabase/migrations/0007_usage_prompt_version.sql'));

// ---------------------------------------------------------------- 汇总
const passed = checks.filter((item) => item.pass).length;
const summary = `\n结果：${passed}/${checks.length} 项通过 ${passed === checks.length ? '✅ 通过' : '❌ 未通过'}`;
console.log(summary);
lines.push(summary);

if (process.argv.includes('--report')) {
  mkdirSync('evals/reports', { recursive: true });
  writeFileSync(
    'evals/reports/F-09-i4-accept.txt',
    [
      '# I4（F-09）自动验收报告',
      `生成时间：${new Date().toISOString()}`,
      '',
      '```',
      ...lines,
      '```',
      '',
      '## 需人工验证的部分',
      '',
      '- [ ] 干净环境按 docs/getting-started.md 从零启动',
      '- [ ] GitHub Actions 首次运行全绿（离线）',
      '- [ ] /demo 在 DEMO_MODE=1 下可看、写接口 403',
      '- [ ] /settings/diagnostics 在做过真实抽取后显示日志',
      '',
    ].join('\n'),
    'utf8',
  );
  console.log('报告已写入 evals/reports/F-09-i4-accept.txt');
}

process.exit(passed === checks.length ? 0 : 1);
