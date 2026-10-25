import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { saveJob } from '../src/lib/jobs/service.ts';
import { ABSENT_DEADLINE, JdExtractionSchema, type JdExtraction } from '../src/lib/schemas/jd.ts';
import { encodeCsv, encodeCsvDocument, parseCsv, UTF8_BOM } from '../src/lib/workspace/csv.ts';
import { exportWorkspace } from '../src/lib/workspace/export.ts';
import { syncWorkspace } from '../src/lib/workspace/sync.ts';
import { workspacePaths } from '../src/lib/workspace/paths.ts';
import {
  MAIN_HEADERS,
  parseCitiesCell,
  parseDateCell,
  parseNumberCell,
  parseSkillCell,
} from '../src/lib/workspace/schema.ts';

const USER = '00000000-0000-4000-8000-000000000001';

const skill = (overrides: Record<string, unknown> = {}) => ({
  name: 'Java',
  source: 'explicit',
  requirement: 'must',
  proficiency: 'expert',
  confidence: 0.9,
  basisPhrase: '精通 Java',
  ...overrides,
});

const extraction = (overrides: Record<string, unknown> = {}): JdExtraction =>
  JdExtractionSchema.parse({
    fields: {
      company: '某科技有限公司',
      title: '后端开发工程师',
      cities: ['上海', '杭州'],
      source: 'manual',
      raw_text: '某科技有限公司招聘后端开发工程师，精通 Java，熟悉 MySQL',
      skills: [skill(), skill({ name: 'MySQL', requirement: 'nice_to_have', proficiency: 'familiar' })],
      deadline: ABSENT_DEADLINE,
      ...overrides,
    },
    evidence: { company: '某科技有限公司', salary_min: '15k-25k' },
    confidence: { company: 0.95, title: 0.95 },
  });

async function setupRepo(count = 1): Promise<{ repo: ReturnType<typeof createMemoryJobRepository>; dir: string; ids: string[] }> {
  const repo = createMemoryJobRepository();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const data = extraction(
      index === 0
        ? {}
        : { company: `第${index + 1}家公司`, title: `岗位${index + 1}`, cities: ['北京'], skills: [] },
    );
    const saved = await saveJob(repo, { userId: USER, extraction: data });
    assert.equal(saved.status, 'created');
    ids.push(saved.job!.id);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'psa-workspace-'));
  return { repo, dir, ids };
}

/** 读主表 → 改某行某列 → 写回（模拟用户在 Excel 里编辑） */
async function editCell(dir: string, jobId: string, header: string, value: string): Promise<void> {
  const paths = workspacePaths(dir);
  const parsed = parseCsv(await readFile(paths.mainTable, 'utf8'));
  const head = parsed.rows[0]!;
  const idIndex = head.findIndex((name) => name === '岗位ID');
  const colIndex = head.findIndex((name) => name === header);
  assert.ok(idIndex >= 0 && colIndex >= 0, `表头缺少列：${header}`);
  const row = parsed.rows.find((item) => item[idIndex] === jobId);
  assert.ok(row, '找不到目标行');
  row[colIndex] = value;
  await writeFile(paths.mainTable, encodeCsvDocument(parsed.rows), 'utf8');
}

// ---------------------------------------------------------------- CSV 编解码
test('CSV：BOM + RFC4180 转义 + 公式注入防护', () => {
  const doc = encodeCsvDocument([[ 'a,b', 'say "hi"', 'line1\nline2' ]]);
  assert.ok(doc.startsWith(UTF8_BOM), '必须带 BOM（否则 Windows Excel 中文乱码）');
  assert.ok(doc.includes('"a,b"'));
  assert.ok(doc.includes('"say ""hi"""'));
  assert.ok(doc.includes('"line1\nline2"'));

  const guarded = encodeCsv([['=1+1', '+1', '-1', '@x', '正常']]);
  assert.ok(guarded.includes("'=1+1"), '公式必须前置单引号');
  assert.ok(guarded.includes("'+1"));
  assert.ok(guarded.includes("'@x"));
});

test('CSV：解析 CRLF / 引号内换行 / 末尾空行', () => {
  const text = 'a,b\r\n"x,y","line1\nline2"\r\n\r\n';
  const parsed = parseCsv(text);
  assert.deepEqual(parsed.rows, [
    ['a', 'b'],
    ['x,y', 'line1\nline2'],
  ]);
});

test('CSV：往返一致（特殊字符不丢失）', () => {
  const rows = [
    ['岗位ID', '备注'],
    ['abc', '含,逗号；含"引号"；换行\n第二行'],
  ];
  assert.deepEqual(parseCsv(encodeCsvDocument(rows)).rows, rows);
});

// ---------------------------------------------------------------- 单元格解析
test('数字：容忍千分位 / 15k / 全角', () => {
  assert.equal(parseNumberCell('15,000'), 15000);
  assert.equal(parseNumberCell('15k'), 15000);
  assert.equal(parseNumberCell('１５０００'), 15000);
  assert.equal(parseNumberCell(''), null);
  assert.equal(parseNumberCell('面议'), null);
});

test('城市：多种分隔符与空值', () => {
  assert.deepEqual(parseCitiesCell('上海 / 杭州'), ['上海', '杭州']);
  assert.deepEqual(parseCitiesCell('上海、杭州;北京'), ['上海', '杭州', '北京']);
  assert.deepEqual(parseCitiesCell(''), []);
  assert.deepEqual(parseCitiesCell('—'), []);
});

test('日期：容忍 2026/11/20 与 2026年11月20日', () => {
  assert.equal(parseDateCell('2026/11/20'), new Date('2026-11-20').toISOString());
  assert.equal(parseDateCell('2026年11月20日'), new Date('2026-11-20').toISOString());
  assert.equal(parseDateCell(''), null);
  assert.equal(parseDateCell('招满为止'), null);
});

test('技能单元格：解析熟练度并忽略括号内未知词', () => {
  const parsed = parseSkillCell('Java(精通); MySQL; Python(熟悉)');
  assert.deepEqual(parsed, [
    { name: 'Java', proficiency: 'expert' },
    { name: 'MySQL', proficiency: 'unknown' },
    { name: 'Python', proficiency: 'familiar' },
  ]);
});

// ---------------------------------------------------------------- 导出
test('导出：主表/技能表/README/原文快照 + BOM', async () => {
  const { repo, dir, ids } = await setupRepo(2);
  const result = await exportWorkspace(repo, USER, { dir });
  assert.equal(result.jobCount, 2);
  assert.ok(result.skillCount >= 2);

  const paths = workspacePaths(dir);
  const main = await readFile(paths.mainTable, 'utf8');
  assert.ok(main.startsWith(UTF8_BOM));
  const parsed = parseCsv(main);
  assert.deepEqual(parsed.rows[0], [...MAIN_HEADERS]);

  const idIndex = parsed.rows[0]!.indexOf('岗位ID');
  // 列表顺序按 createdAt 倒序，测试只关心"两条都在"
  assert.deepEqual(
    parsed.rows
      .slice(1)
      .map((row) => row[idIndex]!)
      .sort(),
    [...ids].sort(),
  );

  const firstRow = parsed.rows.find((row) => row[idIndex] === ids[0])!;
  assert.ok(firstRow[parsed.rows[0]!.indexOf('技能·明确(必须)')]!.includes('Java'));
  assert.ok(firstRow[parsed.rows[0]!.indexOf('技能·明确(加分)')]!.includes('MySQL'));

  const readme = await readFile(paths.readme, 'utf8');
  assert.ok(readme.includes('可改的列'));
  const snapshot = await readFile(path.join(paths.rawDir, `${ids[0]}.md`), 'utf8');
  assert.ok(snapshot.includes('某科技有限公司'));
});

test('导出：保留用户自建列（按岗位ID 回填）', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  const paths = workspacePaths(dir);
  await exportWorkspace(repo, USER, { dir });

  // 模拟：用户在 Excel 里加了一列「内推人」并填值
  const parsed = parseCsv(await readFile(paths.mainTable, 'utf8'));
  parsed.rows[0]!.push('内推人');
  parsed.rows[1]!.push('张三');
  await writeFile(paths.mainTable, encodeCsvDocument(parsed.rows), 'utf8');

  const again = await exportWorkspace(repo, USER, { dir });
  assert.deepEqual(again.preservedColumns, ['内推人']);
  const after = parseCsv(await readFile(paths.mainTable, 'utf8'));
  const col = after.rows[0]!.indexOf('内推人');
  assert.ok(col > 0);
  assert.equal(after.rows[1]![col], '张三');
  assert.equal(after.rows[1]![after.rows[0]!.indexOf('岗位ID')], ids[0]);
});

// ---------------------------------------------------------------- 同步
test('同步：改状态/优先级/备注 → 写库且 revision+1', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await exportWorkspace(repo, USER, { dir });
  await editCell(dir, ids[0]!, '状态', 'to_apply');
  await editCell(dir, ids[0]!, '优先级', '高');
  await editCell(dir, ids[0]!, '备注', '已内推');

  const before = await repo.findById(USER, ids[0]!);
  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.updated, 1);
  assert.equal(report.conflicts, 0);
  assert.ok(report.backup, '同步前必须有备份');

  const after = await repo.findById(USER, ids[0]!);
  assert.equal(after?.status, 'to_apply');
  assert.equal(after?.priority, '高');
  assert.equal(after?.notes, '已内推');
  assert.equal(after!.revision, before!.revision + 1);
});

test('同步：人工校准抽取字段 → 清除对应待确认标记', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  const job = await repo.findById(USER, ids[0]!);
  // 人为制造待确认标记
  await repo.update(USER, ids[0]!, { review_flags: ['company', 'salary_min'] });
  await exportWorkspace(repo, USER, { dir });
  await editCell(dir, ids[0]!, '公司', '某科技（已核对）');

  await syncWorkspace(repo, USER, { dir });
  const after = await repo.findById(USER, ids[0]!);
  assert.equal(after?.company, '某科技（已核对）');
  assert.deepEqual(after?.review_flags, ['salary_min'], 'company 的待确认应被清除');
  assert.ok(job);
});

test('同步：只读列被手改 → 不采纳', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await exportWorkspace(repo, USER, { dir });
  const before = await repo.findById(USER, ids[0]!);
  await editCell(dir, ids[0]!, '待确认字段', 'company,title');
  await editCell(dir, ids[0]!, '剩余天数', '999');

  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.updated, 0, '只读列不触发更新');
  const after = await repo.findById(USER, ids[0]!);
  assert.deepEqual(after?.review_flags, before?.review_flags);
});

test('同步：删行不删数据（受保护）', async () => {
  const { repo, dir, ids } = await setupRepo(2);
  await exportWorkspace(repo, USER, { dir });

  const paths = workspacePaths(dir);
  const parsed = parseCsv(await readFile(paths.mainTable, 'utf8'));
  parsed.rows = [parsed.rows[0]!, parsed.rows[1]!]; // 丢掉第二行
  await writeFile(paths.mainTable, encodeCsvDocument(parsed.rows), 'utf8');

  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.deletedProtected, 1);
  assert.equal(await repo.count(USER), 2, '数据库不得删除');
  assert.ok(report.warnings.some((warning) => warning.includes('被删除')));
  assert.ok(ids.length === 2);
});

test('同步：文件修订号落后 → 冲突记录 + 用户值优先', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await exportWorkspace(repo, USER, { dir });

  // 库里再改一次（revision 变成 2），而表格仍停留在 _rev=1
  await repo.update(USER, ids[0]!, { status: 'interviewing' });
  await editCell(dir, ids[0]!, '状态', 'offer');

  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.conflicts, 1);
  assert.equal((await repo.findById(USER, ids[0]!))?.status, 'offer', '用户值优先');

  const conflicts = await readFile(workspacePaths(dir).conflicts, 'utf8');
  assert.ok(conflicts.includes('招聘中') || conflicts.includes('状态'));
  assert.ok(conflicts.includes('表格修订号'));
});

test('同步：编辑技能列 → 替换明确技能，推测技能保留', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await exportWorkspace(repo, USER, { dir });
  await editCell(dir, ids[0]!, '技能·明确(必须)', 'Go(熟练); Redis');
  await editCell(dir, ids[0]!, '技能·明确(加分)', '');

  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.updated, 1);
  const skills = await repo.listSkills(ids[0]!);
  const explicit = skills.filter((row) => row.source === 'explicit');
  assert.deepEqual(explicit.map((row) => row.skill).sort(), ['Go', 'Redis']);
  assert.equal(explicit.find((row) => row.skill === 'Go')?.proficiency, 'proficient');
  assert.equal(explicit.find((row) => row.skill === 'Redis')?.requirement, 'must');
});

test('同步：表格新增行（有公司+岗位）→ 入库；缺字段跳过', async () => {
  const { repo, dir } = await setupRepo(1);
  const paths = workspacePaths(dir);
  await exportWorkspace(repo, USER, { dir });

  const parsed = parseCsv(await readFile(paths.mainTable, 'utf8'));
  const head = parsed.rows[0]!;
  const buildRow = (values: Record<string, string>) => head.map((name) => values[name] ?? '');
  parsed.rows.push(buildRow({ 公司: '新公司', 岗位: '数据分析师', 城市: '北京', 状态: 'saved' }));
  parsed.rows.push(buildRow({ 公司: '', 岗位: '缺公司' }));
  await writeFile(paths.mainTable, encodeCsvDocument(parsed.rows), 'utf8');

  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.created, 1);
  assert.equal(report.skipped, 1);
  assert.equal(await repo.count(USER), 2);
});

test('同步：日期容忍格式（2026/11/20）', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await exportWorkspace(repo, USER, { dir });
  await editCell(dir, ids[0]!, '截止时间', '2026/11/20');

  await syncWorkspace(repo, USER, { dir });
  const job = await repo.findById(USER, ids[0]!);
  assert.equal(job?.deadline_kind, 'provided');
  assert.equal(job?.deadline?.slice(0, 10), '2026-11-20');
});

test('同步：--dry-run 只报告不写库', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await exportWorkspace(repo, USER, { dir });
  await editCell(dir, ids[0]!, '状态', 'to_apply');

  const before = await repo.findById(USER, ids[0]!);
  const report = await syncWorkspace(repo, USER, { dir, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.updated, 1);
  assert.equal(report.changes.length, 1);
  const after = await repo.findById(USER, ids[0]!);
  assert.equal(after?.status, before?.status, 'dry-run 不得写库');
});

test('同步：缺台账文件 → 明确提示而非崩溃', async () => {
  const { repo, dir } = await setupRepo(1);
  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.updated, 0);
  assert.ok(report.warnings.some((warning) => warning.includes('先运行')));
});

test('同步：往返幂等（导出 → 不改 → 同步 = 0 更新）', async () => {
  // 关键回归：截止日期列只有日期（2026-11-20），库内是当天 23:59:59。
  // 若按全量 ISO 比较，每次同步都会误判成"改过了"，revision 无限增长。
  const { repo, dir } = await setupRepo(1);
  await repo.update(USER, (await repo.list(USER))[0]!.id, {
    deadline: '2026-11-20T23:59:59+08:00',
    deadline_kind: 'provided',
  });

  await exportWorkspace(repo, USER, { dir });
  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.updated, 0, `不应有任何更新，实际：${report.changes.join(' | ')}`);
  assert.equal(report.conflicts, 0);
  assert.equal(report.created, 0);
});

test('同步：下次跟进时间往返幂等（库里带时分秒，表格只有日期）', async () => {
  // 回归：nextActionAt 曾与 deadline 同类问题——按全量 ISO 比较会每次误判「改过了」
  const { repo, dir, ids } = await setupRepo(1);
  await repo.update(USER, ids[0]!, { nextActionAt: '2026-11-01T09:00:00+08:00' });
  await exportWorkspace(repo, USER, { dir });
  const report = await syncWorkspace(repo, USER, { dir });
  assert.equal(report.updated, 0, `不应误判修改，实际：${report.changes.join(' | ')}`);
});

test('同步：清空备注会写库（用户删掉备注是明确意图）', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await repo.update(USER, ids[0]!, { notes: '旧备注' });
  await exportWorkspace(repo, USER, { dir });
  await editCell(dir, ids[0]!, '备注', '');
  await syncWorkspace(repo, USER, { dir });
  assert.equal((await repo.findById(USER, ids[0]!))?.notes, '');
});

test('同步：状态列留空不覆盖库内状态（防止误清空）', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await repo.update(USER, ids[0]!, { status: 'to_apply' });
  await exportWorkspace(repo, USER, { dir });
  await editCell(dir, ids[0]!, '状态', '');
  await syncWorkspace(repo, USER, { dir });
  assert.equal((await repo.findById(USER, ids[0]!))?.status, 'to_apply');
});

test('同步：改城市后 job.city 跟随首城', async () => {
  const { repo, dir, ids } = await setupRepo(1);
  await exportWorkspace(repo, USER, { dir });
  await editCell(dir, ids[0]!, '城市', '北京; 深圳');
  await syncWorkspace(repo, USER, { dir });
  const job = await repo.findById(USER, ids[0]!);
  assert.deepEqual(job?.cities, ['北京', '深圳']);
  assert.equal(job?.city, '北京', '首城列必须同步更新');
});

test('同步：导出后新增的岗位算「未导出」而不是「被删行」', async () => {
  const { repo, dir } = await setupRepo(1);
  await exportWorkspace(repo, USER, { dir });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const later = extraction({ company: '导出后新增公司', title: '新增岗位', cities: ['北京'], skills: [] });
  await saveJob(repo, { userId: USER, extraction: later });

  const report = await syncWorkspace(repo, USER, { dir, dryRun: true });
  assert.equal(report.deletedProtected, 0, '不应误报删行');
  assert.equal(report.notYetExported, 1, '应识别为导出后新增');
  assert.ok(report.warnings.some((warning) => warning.includes('重新导出')), '应提示重新导出而不是报数据丢失');
});

test('导出：包含经历库 CSV（只读备份）', async () => {
  const { repo, dir } = await setupRepo(1);
  const experiences = [
    {
      id: 'exp-1',
      userId: USER,
      type: 'internship' as const,
      org: '某科技',
      role: '后端实习生',
      startDate: '2026-06',
      endDate: '2026-09',
      summary: '后端开发',
      star: { situation: '超时', task: '降延迟', action: '改查询', result: '降 30%' },
      skills: ['Java'],
      metrics: [{ metric: '提升', value: 30, unit: '%', raw: '提升 30%' }],
      evidenceUrls: [],
      rawText: '',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
      deletedAt: null,
    },
  ];
  const result = await exportWorkspace(repo, USER, { dir, experiences });
  assert.equal(result.experienceCount, 1);

  const paths = workspacePaths(dir);
  const content = await readFile(paths.experiencesTable, 'utf8');
  assert.ok(content.includes('S 情境'), '应有表头');
  assert.ok(content.includes('某科技'));
  assert.ok(content.includes('降 30%'));
  assert.ok(content.includes('是'), '行动+结果齐全应标为可用于简历');
});
