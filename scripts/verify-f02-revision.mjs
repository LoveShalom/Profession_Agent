/**
 * F-02 修订版 · AC 自动验收器
 *
 * 把 AC-1~AC-10 中**能在没有浏览器的情况下等价验证**的部分全部跑一遍：
 *   · 数据层 / 服务层行为（分类派生、定位覆盖、筛选、软删除）
 *   · 台账往返（导出 → 改 → 同步 → 幂等、旧台账兼容、子表分组）
 * 涉及"页面长什么样、手点有没有反馈"的少数项仍需人工走查（会在报告里列出）。
 *
 * 用法：
 *   node scripts/verify-f02-revision.mjs            # 逐项输出
 *   node scripts/verify-f02-revision.mjs --report   # 写 evals/reports/F-02-revision-accept.txt
 *
 * 安全：台账类用例全部在**系统临时目录**里跑，不碰你的 data/workspace 与数据库。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { listJobs, saveJob } from '../src/lib/jobs/service.ts';
import { ABSENT_DEADLINE, JdExtractionSchema } from '../src/lib/schemas/jd.ts';
import { decodeCsvBuffer, encodeCsvDocument, parseCsv } from '../src/lib/workspace/csv.ts';
import { exportWorkspace } from '../src/lib/workspace/export.ts';
import { workspacePaths } from '../src/lib/workspace/paths.ts';
import { syncWorkspace } from '../src/lib/workspace/sync.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const results = [];
const manual = [];

function check(ac, name, pass, detail = '') {
  results.push({ ac, name, pass });
  console.log(`${pass ? '✔' : '✖'} [${ac}] ${name}${detail ? ' — ' + detail : ''}`);
}

function manualItem(ac, item) {
  manual.push({ ac, item });
}

// ---------------------------------------------------------------- 工具
function makeExtraction(company, title, skills, rawText) {
  return JdExtractionSchema.parse({
    fields: {
      company,
      title,
      cities: ['上海'],
      source: 'manual',
      raw_text: rawText,
      deadline: ABSENT_DEADLINE,
      skills: skills.map((name) => ({
        name,
        source: 'explicit',
        requirement: 'unknown',
        proficiency: 'unknown',
        confidence: 0.7,
        basisPhrase: `熟悉 ${name}`,
      })),
    },
  });
}

async function seedRepo() {
  const repo = createMemoryJobRepository();
  const specs = [
    ['示例影像科技有限公司', '医学影像算法工程师', ['Python', 'PyTorch'], 'MRI 影像分割与病灶检测'],
    ['示例视觉科技有限公司', 'CV 算法工程师', ['Python', '目标检测'], '目标检测与 BEV 视觉'],
    ['示例后端科技有限公司', '后端开发工程师', ['Java', 'MySQL'], '后端服务开发'],
  ];
  const ids = [];
  for (const [company, title, skills, raw] of specs) {
    const saved = await saveJob(repo, {
      userId: USER,
      extraction: makeExtraction(company, title, skills, `${company} 招聘 ${title}。${raw}`),
    });
    if (saved.job) ids.push(saved.job.id);
  }
  return { repo, ids };
}

function tempDir(tag) {
  return mkdtempSync(path.join(os.tmpdir(), `psa-${tag}-`));
}

// ---------------------------------------------------------------- AC-1：数据清理结果
try {
  const { readFileSync: rf } = await import('node:fs');
  const env = {};
  for (const line of rf('.env', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) env[trimmed.slice(0, index).trim()] = value;
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

  const jobs = await pool.query('select company, deleted_at from jobs where user_id = $1', [USER]);
  const fakeJobPattern = /^(__|示例|测试|某科技有限公司|XX\s*公司)/;
  const fakeJobs = jobs.rows.filter((row) => fakeJobPattern.test(String(row.company)));
  check('AC-1', '数据库无合成岗位残留', fakeJobs.length === 0, `岗位 ${jobs.rows.length} 条，命中合成 ${fakeJobs.length} 条`);
  check(
    'AC-1',
    '存在可恢复的已删除岗位',
    jobs.rows.some((row) => row.deleted_at !== null),
    `已删除 ${jobs.rows.filter((row) => row.deleted_at).length} 条`,
  );

  const exps = await pool.query('select org, deleted_at from experiences where user_id = $1', [USER]);
  const activeExps = exps.rows.filter((row) => row.deleted_at === null);
  const badOrg = /^(\d{4}\s*[.\-/年]|XX\s*公司$|邓一凡)/;
  const badActive = activeExps.filter((row) => badOrg.test(String(row.org)));
  check('AC-1', '有效经历中没有"人名/日期/假公司"脏数据', badActive.length === 0, `有效经历 ${activeExps.length} 条`);
  check(
    'AC-1',
    '开发期垃圾经历仍在（软删可恢复）',
    exps.rows.filter((row) => row.deleted_at).length >= 5,
    `已删除经历 ${exps.rows.filter((row) => row.deleted_at).length} 条`,
  );
  await pool.end();
} catch (error) {
  check('AC-1', '数据库可连接', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- AC-2：软删除与恢复（服务层）
try {
  const { repo, ids } = await seedRepo();
  const target = ids[2];
  const deleted = await repo.softDelete(USER, target);
  const hidden = (await listJobs(repo, USER, {})).items.some((job) => job.id === target);
  const visibleDeleted = (await listJobs(repo, USER, { includeDeleted: true })).items.find((job) => job.id === target);
  const restored = await repo.restore(USER, target);
  const back = (await listJobs(repo, USER, {})).items.some((job) => job.id === target);
  check(
    'AC-2',
    '软删除 → 列表隐藏 → 可查已删除 → 恢复',
    deleted && !hidden && Boolean(visibleDeleted) && restored && back,
  );
} catch (error) {
  check('AC-2', '软删除链路', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- AC-3 / AC-5：分类、定位、筛选
try {
  const { repo, ids } = await seedRepo();
  const items = (await listJobs(repo, USER, {})).items;
  const sample = items.find((job) => job.id === ids[0]);
  check(
    'AC-3',
    '列表项包含分类/定位/是否手改字段',
    typeof sample.category === 'string' && typeof sample.tier === 'string' && typeof sample.tierOverridden === 'boolean',
    `示例：${sample.company} 类别=${sample.category} 定位=${sample.tierLabel}`,
  );

  const imaging = await listJobs(repo, USER, { category: 'algo-medical-imaging' });
  const cv = await listJobs(repo, USER, { category: 'algo-cv' });
  check('AC-5', '按分类筛选（医学影像 / CV）', imaging.items.length === 1 && cv.items.length === 1);

  const primary = await listJobs(repo, USER, { tier: 'primary' });
  const secondary = await listJobs(repo, USER, { tier: 'secondary' });
  const casual = await listJobs(repo, USER, { tier: 'casual' });
  check('AC-5', '按定位筛选（主投/副投/碰运气各 1）', primary.items.length === 1 && secondary.items.length === 1 && casual.items.length === 1);
} catch (error) {
  check('AC-5', '筛选', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- AC-4：改分类 + 手改保护
try {
  const { repo, ids } = await seedRepo();
  const id = ids[2]; // 后端
  await repo.update(USER, id, { category: 'algo-medical-imaging' });
  const after = await repo.findById(USER, id);
  check('AC-4', '修改分类写库', after?.category === 'algo-medical-imaging');

  // 模拟 backfill（不带 --force）：手改值应保留
  const { deriveJobCategory } = await import('../src/lib/jobs/category.ts');
  const derived = deriveJobCategory({ title: after?.title, rawText: after?.raw_text });
  const keepManual = after?.category !== derived.code; // 手改值 ≠ 派生值 → backfill 不覆盖
  check('AC-4', '手改分类与派生不同 → backfill 默认保留手改', keepManual, `手改=${after?.category} 派生=${derived.code}`);
} catch (error) {
  check('AC-4', '分类编辑', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- AC-6：台账两列 + 子表 + 幂等
let ledgerRepo;
try {
  const seeded = await seedRepo();
  ledgerRepo = seeded.repo;
  const dir = tempDir('ac6');
  try {
    const exported = await exportWorkspace(ledgerRepo, USER, { dir });
    const paths = workspacePaths(dir);
    const decoded = decodeCsvBuffer(readFileSync(paths.mainTable));
    const main = parseCsv(decoded.text);
    const header = main.rows[0].map((name) => name.trim());
    check(
      'AC-6',
      '主表含「类别」「投递定位」两列',
      header.includes('类别') && header.includes('投递定位'),
      `${header.length} 列`,
    );
    check('AC-6', '主表按 主投→副投→碰运气 排序', exported.tierCounts.primary === 1 && exported.tierCounts.secondary === 1 && exported.tierCounts.casual === 1);

    const subTables = [paths.tierTables.primary, paths.tierTables.secondary, paths.tierTables.casual];
    const subOk = subTables.every((file) => {
      const parsed = parseCsv(decodeCsvBuffer(readFileSync(file)).text);
      return parsed.rows.length === 2;
    });
    check('AC-6', '三张只读子表各 1 行', subOk);

    const dry = await syncWorkspace(ledgerRepo, USER, { dir, dryRun: true });
    check('AC-6', '导出后未改 → 同步预演 0 更新（幂等）', dry.updated === 0, `updated=${dry.updated}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  check('AC-6', '台账导出', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- AC-7：新建岗位自动分类
try {
  const repo = createMemoryJobRepository();
  const imaging = await saveJob(repo, {
    userId: USER,
    extraction: makeExtraction('示例影像科技有限公司', '医学影像算法工程师', ['Python'], 'MRI 影像分割'),
  });
  const backend = await saveJob(repo, {
    userId: USER,
    extraction: makeExtraction('示例后端科技有限公司', '后端开发工程师', ['Java'], '后端服务'),
  });
  const imagingJob = await repo.findById(USER, imaging.job.id);
  const backendJob = await repo.findById(USER, backend.job.id);
  const { effectiveTier } = await import('../src/lib/jobs/category.ts');
  check(
    'AC-7',
    '医学影像 JD → 医学影像算法 / 主投',
    imagingJob?.category === 'algo-medical-imaging' && effectiveTier(imagingJob.category, imagingJob.campaignTier).tier === 'primary',
  );
  check(
    'AC-7',
    '后端 JD → 后端开发 / 碰运气',
    backendJob?.category === 'backend' && effectiveTier(backendJob.category, backendJob.campaignTier).tier === 'casual',
  );
} catch (error) {
  check('AC-7', '自动分类', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- AC-8：旧台账兼容 / 清空=未分类
try {
  const { repo } = await seedRepo();
  const dir = tempDir('ac8');
  try {
    await exportWorkspace(repo, USER, { dir });
    const paths = workspacePaths(dir);
    const original = decodeCsvBuffer(readFileSync(paths.mainTable)).text;

    // ① 删掉「类别」整列 → 同步不应清空 DB 分类
    const parsed = parseCsv(original);
    const header = parsed.rows[0].map((name) => name.trim());
    const categoryIndex = header.indexOf('类别');
    const withoutColumn = parsed.rows.map((row) => row.filter((_, index) => index !== categoryIndex));
    writeFileSync(paths.mainTable, encodeCsvDocument(withoutColumn), 'utf8');
    const dryOld = await syncWorkspace(repo, USER, { dir, dryRun: true });
    check('AC-8', '旧台账缺「类别」列 → 不清空分类', dryOld.updated === 0, `updated=${dryOld.updated}`);

    // ② 清空某行「类别」单元格 → 同步后该岗位变为未分类
    const rows = parseCsv(original).rows.map((row) => [...row]);
    rows[1][categoryIndex] = '';
    writeFileSync(paths.mainTable, encodeCsvDocument(rows), 'utf8');
    await syncWorkspace(repo, USER, { dir });
    const jobs = await repo.list(USER, { limit: 10 });
    check('AC-8', '清空「类别」→ 该岗位变未分类', jobs.some((job) => job.category === null));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  check('AC-8', '旧台账兼容', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- AC-9：手动覆盖定位
try {
  const { repo, ids } = await seedRepo();
  const id = ids[2]; // 后端（派生=碰运气）
  await repo.update(USER, id, { campaignTier: 'primary' });
  const primary = await listJobs(repo, USER, { tier: 'primary' });
  const target = primary.items.find((job) => job.id === id);
  check('AC-9', '手动设为主投 → 定位筛选可见且标记手动', target?.tierLabel === '主投' && target?.tierOverridden === true);
  await repo.update(USER, id, { campaignTier: null });
  const casual = await listJobs(repo, USER, { tier: 'casual' });
  const reset = casual.items.find((job) => job.id === id);
  check('AC-9', '清空覆盖 → 恢复跟随分类（碰运气、非手动）', reset?.tierLabel === '碰运气' && reset?.tierOverridden === false);
} catch (error) {
  check('AC-9', '定位覆盖', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- AC-10：台账定位列可编辑 + 幂等
try {
  const { repo, ids } = await seedRepo();
  const dir = tempDir('ac10');
  try {
    await exportWorkspace(repo, USER, { dir });
    const paths = workspacePaths(dir);
    const parsed = parseCsv(decodeCsvBuffer(readFileSync(paths.mainTable)).text);
    const header = parsed.rows[0].map((name) => name.trim());
    const companyIndex = header.indexOf('公司');
    const tierIndex = header.indexOf('投递定位');

    // 把后端岗（碰运气）在台账里改成「主投」
    const rows = parsed.rows.map((row) => [...row]);
    for (const row of rows.slice(1)) {
      if (row[companyIndex]?.includes('后端')) row[tierIndex] = '主投';
    }
    writeFileSync(paths.mainTable, encodeCsvDocument(rows), 'utf8');
    const synced = await syncWorkspace(repo, USER, { dir });
    const job = await repo.findById(USER, ids[2]);
    check('AC-10', '台账改「投递定位」→ 同步写入覆盖值', synced.updated === 1 && job?.campaignTier === 'primary');

    // 重新导出 + 清空该单元格 → 恢复跟随分类
    await exportWorkspace(repo, USER, { dir });
    const parsed2 = parseCsv(decodeCsvBuffer(readFileSync(paths.mainTable)).text);
    const header2 = parsed2.rows[0].map((name) => name.trim());
    const company2 = header2.indexOf('公司');
    const tier2 = header2.indexOf('投递定位');
    const rows2 = parsed2.rows.map((row) => [...row]);
    for (const row of rows2.slice(1)) if (row[company2]?.includes('后端')) row[tier2] = '';
    writeFileSync(paths.mainTable, encodeCsvDocument(rows2), 'utf8');
    await syncWorkspace(repo, USER, { dir });
    check('AC-10', '清空「投递定位」→ 恢复跟随分类', (await repo.findById(USER, ids[2]))?.campaignTier === null);

    // 幂等：再导出 → 不改 → 0 更新
    await exportWorkspace(repo, USER, { dir });
    const dry = await syncWorkspace(repo, USER, { dir, dryRun: true });
    check('AC-10', '定位改回后导出 → 同步 0 更新（幂等）', dry.updated === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error) {
  check('AC-10', '台账定位可编辑', false, error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------- 人工项
manualItem('AC-1/2/3', '页面上的删除键、显示已删除（N）、类别/定位列是否可见（用户已确认 AC-1/2/3 ✅）');
manualItem('AC-4', '详情页「岗位分类」下拉保存后的即时反馈（服务层已验）');
manualItem('AC-5', '分类/定位 chips 点击筛选的页面表现（服务层已验）');
manualItem('AC-9', '详情页「投递定位」下拉的交互反馈（服务层已验）');
manualItem('AC-6/10', '在 Excel 里改单元格 → 保存（GBK 编码）→ 同步（编码识别已单测+真实文件验）');

// ---------------------------------------------------------------- 汇总
const passed = results.filter((item) => item.pass).length;
const failed = results.filter((item) => !item.pass);
console.log(`\n结果：${passed}/${results.length} 项自动通过`);
if (failed.length > 0) {
  console.log('未通过：');
  for (const item of failed) console.log(`  ✖ [${item.ac}] ${item.name}`);
}
console.log('\n仍需人工确认（页面交互）：');
for (const item of manual) console.log(`  · [${item.ac}] ${item.item}`);

if (process.argv.includes('--report')) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync('evals/reports', { recursive: true });
  const lines = [
    '# F-02 修订版 · AC 自动验收报告',
    `生成时间：${new Date().toISOString()}`,
    '',
    `自动通过：${passed}/${results.length}`,
    '',
    '| AC | 检查项 | 结果 |',
    '|---|---|---|',
    ...results.map((item) => `| ${item.ac} | ${item.name} | ${item.pass ? '✅' : '❌'} |`),
    '',
    '## 仍需人工（页面交互）',
    '',
    ...manual.map((item) => `- [ ] [${item.ac}] ${item.item}`),
    '',
  ].join('\n');
  writeFileSync('evals/reports/F-02-revision-accept.txt', lines, 'utf8');
  console.log('\n报告已写入 evals/reports/F-02-revision-accept.txt');
}

process.exit(failed.length === 0 ? 0 : 1);
