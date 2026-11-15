/**
 * 评测器（F-09 / I4 T2）
 *
 * 三种模式：
 *   --mode=rules    默认。规则抽取（L4），**离线、无 Key、确定性**，CI 用它
 *   --mode=replay   回放 fixtures（`evals/jd/fixtures/<id>.json`，由 `--record --real` 生成）
 *   --mode=real     调真实模型（需要 .env 配置 Key；成本 ≈ ¥0.02/条）
 *
 * 用法：
 *   npm run eval                                  # rules 基线（CI 用）
 *   npm run eval -- --subset=10 --report
 *   npm run eval -- --mode=real --record          # 录制 fixtures（需要 Key）
 *   npm run eval -- --mode=replay --report        # 回归（用录好的 fixtures）
 *
 * 退出码：0 通过；1 低于基线（基线缺失时自动建立并退出 0）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { extractSkills } from '../src/lib/pipeline/skills.ts';
import { aggregate, scoreItem } from '../src/lib/eval/scoring.ts';
import { extractJd } from '../src/lib/llm/extract.ts';

const DATASET = 'evals/jd/dataset.jsonl';
const LOCK = 'evals/jd/dataset.lock.json';
const BASELINE = 'evals/jd/baseline.json';
const FIXTURES = 'evals/jd/fixtures';
const REPORTS = 'evals/reports';

const argv = process.argv.slice(2);
const mode = (argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1] ?? 'rules');
const subset = Number(argv.find((arg) => arg.startsWith('--subset='))?.split('=')[1] ?? '0');
const wantReport = argv.includes('--report');
const wantRecord = argv.includes('--record');
const REGRESSION_TOLERANCE = Number(argv.find((arg) => arg.startsWith('--tolerance='))?.split('=')[1] ?? '3');

if (!['rules', 'replay', 'real'].includes(mode)) {
  console.error(`✖ 未知模式：${mode}（可选 rules / replay / real）`);
  process.exit(2);
}

// ---------------------------------------------------------------- 载入并校验评测集
if (!existsSync(DATASET) || !existsSync(LOCK)) {
  console.error('✖ 缺少评测集或 lock，先运行 npm run eval:dataset');
  process.exit(2);
}
const datasetText = readFileSync(DATASET, 'utf8');
const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const actualHash = createHash('sha256').update(datasetText).digest('hex');
if (actualHash !== lock.sha256) {
  console.error('✖ 评测集与 lock 不一致（被改过）。review 后运行 npm run eval:dataset 重新生成并提交');
  process.exit(2);
}

const allItems = datasetText
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const items = subset > 0 ? allItems.slice(0, subset) : allItems;
console.log(`▶ 评测集 ${items.length}/${allItems.length} 条 · 模式 ${mode}${wantRecord ? ' · 录制' : ''}`);

// ---------------------------------------------------------------- 真实模型服务（仅 rare 用）
async function createService() {
  if (mode !== 'real') return null;
  try {
    const { getModelRouter } = await import('../src/lib/server/models.ts');
    const router = await getModelRouter();
    if (!router.text?.hasCredential) {
      console.error('✖ real 模式需要有效文本模型凭证（.env 或 /settings/llm）');
      process.exit(2);
    }
    return router.text;
  } catch (error) {
    console.error(`✖ 初始化模型失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

const service = await createService();
if (wantRecord && mode !== 'real' && mode !== 'replay') {
  console.error('✖ --record 只能配 --mode=real 使用');
  process.exit(2);
}
if (wantRecord) mkdirSync(FIXTURES, { recursive: true });

// ---------------------------------------------------------------- 逐条评测
const scores = [];
const rows = [];
for (const [index, item] of items.entries()) {
  let extraction;
  try {
    if (mode === 'replay') {
      const fixturePath = `${FIXTURES}/${item.id}.json`;
      if (!existsSync(fixturePath)) {
        console.error(`✖ 缺少 fixture：${fixturePath}（先运行 --mode=real --record）`);
        process.exit(2);
      }
      extraction = JSON.parse(readFileSync(fixturePath, 'utf8')).extraction;
    } else {
      const result = await extractJd(
        { rawText: item.raw_text, source: 'manual' },
        { service: mode === 'real' ? service : null },
      );
      extraction = result.extraction;
      if (wantRecord) {
        writeFileSync(
          `${FIXTURES}/${item.id}.json`,
          JSON.stringify({ recordedAt: new Date().toISOString(), mode, extraction }, null, 2) + '\n',
          'utf8',
        );
      }
    }
  } catch (error) {
    console.error(`✖ ${item.id} 抽取失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // 技能不在 extraction 里：走与入库同一条管线（extractSkills），避免评测与产品口径不一致
  const skills = extractSkills(item.raw_text, { includeInferred: true }).map((skill) => skill.name);
  const pred = {
    company: extraction.fields.company ?? null,
    title: extraction.fields.title ?? null,
    cities: extraction.fields.cities ?? [],
    deadline_kind: extraction.fields.deadline.kind,
    deadline_at: extraction.fields.deadline.at ?? null,
    salary_min: extraction.fields.salary_min ?? null,
    salary_max: extraction.fields.salary_max ?? null,
    skills,
  };
  const gold = item.gold;
  const score = scoreItem(gold, pred);
  scores.push(score);
  rows.push({ id: item.id, macro: score.macro, perField: score.perField });

  const flag = score.macro >= 0.999 ? '✔' : score.macro >= 0.6 ? '◐' : '✖';
  console.log(
    `${flag} ${String(index + 1).padStart(2, '0')}/${items.length} ${item.id} macro=${score.macro.toFixed(2)} ` +
      Object.entries(score.perField)
        .filter(([, value]) => value !== null)
        .map(([field, value]) => `${field}=${value === null ? '-' : value.toFixed(2)}`)
        .join(' '),
  );
}

const result = aggregate(scores);
console.log('\n=== 汇总 ===');
console.log(`宏平均：${(result.macro * 100).toFixed(1)}%`);
for (const [field, bucket] of Object.entries(result.perField)) {
  console.log(`  ${field.padEnd(8)} ${(bucket.score * 100).toFixed(1)}%  （评估 ${bucket.evaluated} 条，全对 ${bucket.perfect}）`);
}

// ---------------------------------------------------------------- 基线比对
let verdict = 'ok';
let baselineInfo = '';
if (mode === 'rules' || mode === 'replay') {
  if (!existsSync(BASELINE)) {
    const baseline = {
      mode,
      macro: Number(result.macro.toFixed(4)),
      perField: Object.fromEntries(Object.entries(result.perField).map(([key, value]) => [key, Number(value.score.toFixed(4))])),
      items: result.items,
      datasetSha256: lock.sha256,
      createdAt: new Date().toISOString(),
      note: '基线是质量契约：提升时更新并记录；退化超过 3pt 会使 eval 失败',
    };
    writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    baselineInfo = `基线已建立：${(result.macro * 100).toFixed(1)}%（${BASELINE}）`;
    console.log(`\nℹ ${baselineInfo}`);
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const delta = (result.macro - baseline.macro) * 100;
    baselineInfo = `基线 ${(baseline.macro * 100).toFixed(1)}% → 本次 ${(result.macro * 100).toFixed(1)}%（Δ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pt）`;
    console.log(`\n${baselineInfo}`);
    if (baseline.mode !== mode) {
      console.log(`⚠ 基线来自 ${baseline.mode} 模式，与当前模式（${mode}）不同，未做退化判定`);
    } else if (delta < -REGRESSION_TOLERANCE) {
      verdict = 'regressed';
      console.log(`✖ 退化超过 ${REGRESSION_TOLERANCE}pt，判为不通过`);
    }
  }
}

// ---------------------------------------------------------------- 报告
if (wantReport) {
  mkdirSync(REPORTS, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const report = [
    `# F-09 评测报告（${mode}）`,
    `生成时间：${new Date().toISOString()}`,
    `评测集：${result.items} 条（sha256=${lock.sha256.slice(0, 16)}…）`,
    '',
    `宏平均：${(result.macro * 100).toFixed(1)}%`,
    '',
    '| 字段 | 分数 | 评估条数 | 全对 |',
    '|---|---|---|---|',
    ...Object.entries(result.perField).map(
      ([field, bucket]) => `| ${field} | ${(bucket.score * 100).toFixed(1)}% | ${bucket.evaluated} | ${bucket.perfect} |`,
    ),
    '',
    `基线：${baselineInfo}`,
    `结论：${verdict === 'regressed' ? '❌ 退化' : '✅ 通过'}`,
    '',
    '## 明细',
    '',
    '| id | macro | ' + Object.keys(result.perField).join(' | ') + ' |',
    '|---|---|' + Object.keys(result.perField).map(() => '---|').join(''),
    ...rows.map(
      (row) =>
        `| ${row.id} | ${row.macro.toFixed(2)} | ` +
        Object.keys(result.perField)
          .map((field) => {
            const value = row.perField[field];
            return value === null ? '-' : value.toFixed(2);
          })
          .join(' | ') +
        ' |',
    ),
    '',
  ].join('\n');
  const reportPath = `${REPORTS}/eval-${mode}-${date}.txt`;
  writeFileSync(reportPath, report, 'utf8');
  console.log(`报告已写入 ${reportPath}（该目录默认不进 Git）`);
}

process.exit(verdict === 'regressed' ? 1 : 0);
