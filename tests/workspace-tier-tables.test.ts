import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { saveJob } from '../src/lib/jobs/service.ts';
import { ABSENT_DEADLINE, JdExtractionSchema } from '../src/lib/schemas/jd.ts';
import { exportWorkspace } from '../src/lib/workspace/export.ts';
import { parseCsv } from '../src/lib/workspace/csv.ts';
import { workspacePaths } from '../src/lib/workspace/paths.ts';

const USER = '00000000-0000-4000-8000-000000000001';

async function seed() {
  const repo = createMemoryJobRepository();
  const specs: Array<[string, string, string[]]> = [
    ['示例影像科技有限公司', '医学影像算法工程师', ['Python', 'PyTorch']],
    ['示例视觉科技有限公司', 'CV 算法工程师', ['Python', '目标检测']],
    ['示例后端科技有限公司', '后端开发工程师', ['Java', 'MySQL']],
  ];
  for (const [company, title, skills] of specs) {
    const saved = await saveJob(repo, {
      userId: USER,
      extraction: JdExtractionSchema.parse({
        fields: {
          company,
          title,
          cities: ['上海'],
          source: 'manual',
          raw_text: `${company} 招聘 ${title}，熟悉 ${skills.join('、')}。`,
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
      }),
    });
    assert.equal(saved.status, 'created');
  }
  return repo;
}

test('导出：主表按主投→副投→碰运气排序，并生成三张只读子表', async () => {
  const repo = await seed();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'psa-ws-tier-'));
  try {
    const result = await exportWorkspace(repo, USER, { dir });
    assert.deepEqual(result.tierCounts, { primary: 1, secondary: 1, casual: 1 });

    const paths = workspacePaths(dir);

    // 主表顺序：医学影像（主投）→ CV（副投）→ 后端（碰运气）
    const main = parseCsv(readFileSync(paths.mainTable, 'utf8'));
    const companyIndex = main.rows[0]!.findIndex((name) => name.trim() === '公司');
    const mainCompanies = main.rows.slice(1).map((row) => row[companyIndex]);
    assert.deepEqual(mainCompanies, ['示例影像科技有限公司', '示例视觉科技有限公司', '示例后端科技有限公司']);

    // 三张子表各 1 行，且与主表同列数
    for (const [tier, file, expected] of [
      ['primary', paths.tierTables.primary, '示例影像科技有限公司'],
      ['secondary', paths.tierTables.secondary, '示例视觉科技有限公司'],
      ['casual', paths.tierTables.casual, '示例后端科技有限公司'],
    ] as const) {
      const parsed = parseCsv(readFileSync(file, 'utf8'));
      assert.equal(parsed.rows.length, 2, `${tier} 表应为表头 + 1 行`);
      assert.equal(parsed.rows[0]!.length, main.rows[0]!.length, `${tier} 表列数应与主表一致`);
      const index = parsed.rows[0]!.findIndex((name) => name.trim() === '公司');
      assert.equal(parsed.rows[1]![index], expected);
    }

    // files 列表包含子表
    assert.ok(result.files.includes(paths.tierTables.primary));
    assert.ok(result.files.includes(paths.tierTables.secondary));
    assert.ok(result.files.includes(paths.tierTables.casual));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('导出：子表定位与实际覆盖一致（手动覆盖改为副投的医学影像岗进副投表）', async () => {
  const repo = await seed();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'psa-ws-tier2-'));
  try {
    const jobs = await repo.list(USER, { limit: 10 });
    const imaging = jobs.find((job) => job.title.includes('医学影像'))!;
    await repo.update(USER, imaging.id, { campaignTier: 'secondary' });

    const result = await exportWorkspace(repo, USER, { dir });
    assert.deepEqual(result.tierCounts, { primary: 0, secondary: 2, casual: 1 });

    const paths = workspacePaths(dir);
    const secondary = parseCsv(readFileSync(paths.tierTables.secondary, 'utf8'));
    assert.equal(secondary.rows.length, 3, '副投表应有 2 行数据');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
