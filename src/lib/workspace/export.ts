/**
 * 工作区导出（F-03 T1）
 *
 * 导出不是"打印一遍数据"这么简单，要满足四件事：
 *   1. 主表列顺序稳定（用户可能按列筛选，顺序变了会烦）；
 *   2. **保留用户自建列**（按 `岗位ID` 回填，避免每次导出把"内推人"这类列冲掉）；
 *   3. 原文快照按岗位落盘（`原始JD/<id>.md`），已存在则不覆盖（用户可能改过）；
 *   4. 全部写盘失败时给出可操作错误，而不是半截文件。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { JobRepository } from '../db/types.ts';
import type { ExperienceRecord } from '../experience/service.ts';

import { encodeCsvDocument, parseCsv } from './csv.ts';
import { README_TEXT, workspacePaths, type WorkspacePaths } from './paths.ts';
import {
  MAIN_HEADERS,
  PROFICIENCY_LABEL,
  REQUIREMENT_LABEL,
  SKILL_HEADERS,
  SKILL_SOURCE_LABEL,
  jobToRow,
} from './schema.ts';

/** 经历库导出表头（只读备份：类型/组织/角色/时间/STAR 四段/技能/指标/可用性） */
export const EXPERIENCE_HEADERS: readonly string[] = [
  '类型',
  '组织',
  '角色',
  '开始',
  '结束',
  '摘要',
  'S 情境',
  'T 任务',
  'A 行动',
  'R 结果',
  '技能',
  '量化指标',
  '可用于简历',
  '更新时间',
];

const EXPERIENCE_TYPE_LABEL: Record<string, string> = {
  internship: '实习',
  project: '项目',
  research: '科研',
  club: '社团',
};

export interface ExportResult {
  dir: string;
  jobCount: number;
  skillCount: number;
  experienceCount: number;
  files: string[];
  /** 保留的用户自建列 */
  preservedColumns: string[];
  warnings: string[];
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

/** 读取已有主表，取出「用户自建列」的值（按 岗位ID 索引） */
async function loadCustomColumns(mainTable: string): Promise<{ headers: string[]; values: Map<string, Map<string, string>> }> {
  const empty = { headers: [] as string[], values: new Map<string, Map<string, string>>() };
  if (!(await fileExists(mainTable))) return empty;

  const parsed = parseCsv(await readFile(mainTable, 'utf8'));
  const header = parsed.rows[0];
  if (!header) return empty;

  const known = new Set(MAIN_HEADERS);
  const customHeaders = header.map((name) => name.trim()).filter((name) => name.length > 0 && !known.has(name));
  if (customHeaders.length === 0) return empty;

  const idIndex = header.findIndex((name) => name.trim() === '岗位ID');
  if (idIndex < 0) return empty;

  const values = new Map<string, Map<string, string>>();
  for (const row of parsed.rows.slice(1)) {
    const id = (row[idIndex] ?? '').trim();
    if (id.length === 0) continue;
    const record = new Map<string, string>();
    for (const name of customHeaders) {
      const index = header.findIndex((item) => item.trim() === name);
      record.set(name, index >= 0 ? (row[index] ?? '') : '');
    }
    values.set(id, record);
  }
  return { headers: customHeaders, values };
}

export async function exportWorkspace(
  repo: JobRepository,
  userId: string,
  options: { dir?: string; limit?: number; now?: Date; readmeDir?: string; experiences?: readonly ExperienceRecord[] } = {},
): Promise<ExportResult> {
  const paths: WorkspacePaths = workspacePaths(options.dir);
  const now = options.now ?? new Date();
  const warnings: string[] = [];

  await mkdir(paths.rawDir, { recursive: true });
  await mkdir(paths.backupDir, { recursive: true });

  const jobs = await repo.list(userId, { limit: options.limit ?? 500 });

  const custom = await loadCustomColumns(paths.mainTable);
  const mainRows: string[][] = [[...MAIN_HEADERS, ...custom.headers]];
  const skillRows: string[][] = [[...SKILL_HEADERS]];

  for (const job of jobs) {
    const skills = await repo.listSkills(job.id);
    const row = jobToRow(job, skills, now);
    for (const header of custom.headers) {
      row.push(custom.values.get(job.id)?.get(header) ?? '');
    }
    mainRows.push(row);

    for (const skill of skills) {
      skillRows.push([
        job.id,
        job.company,
        job.title,
        skill.skill,
        SKILL_SOURCE_LABEL[skill.source],
        REQUIREMENT_LABEL[skill.requirement] ?? skill.requirement,
        PROFICIENCY_LABEL[skill.proficiency] ?? '',
        skill.confidence.toFixed(2),
        skill.basisPhrase,
      ]);
    }

    // 原文快照：已存在则不覆盖（用户可能已手动整理）
    const snapshot = path.join(paths.rawDir, `${job.id}.md`);
    if (!(await fileExists(snapshot))) {
      const header = `# ${job.company} / ${job.title}\n\n> 岗位ID: ${job.id}\n> 来源: ${job.source}${job.source_url ? ` (${job.source_url})` : ''}\n> 导出时间: ${now.toISOString()}\n\n---\n\n`;
      await writeFile(snapshot, `${header}${job.raw_text}\n`, 'utf8');
    }
  }

  // 经历库：只读备份表（不进同步流程，避免与岗位台账抢冲突）
  const experiences = options.experiences ?? [];
  const experienceRows: string[][] = [[...EXPERIENCE_HEADERS]];
  for (const item of experiences) {
    experienceRows.push([
      EXPERIENCE_TYPE_LABEL[item.type] ?? item.type,
      item.org,
      item.role ?? '',
      item.startDate ?? '',
      item.endDate ?? '',
      item.summary,
      item.star.situation,
      item.star.task,
      item.star.action,
      item.star.result,
      item.skills.join('; '),
      item.metrics.map((metric) => `${metric.metric} ${metric.value}${metric.unit}`).join('; '),
      item.star.action.trim().length > 0 && item.star.result.trim().length > 0 ? '是' : '否',
      item.updatedAt.slice(0, 10),
    ]);
  }
  await writeFile(paths.experiencesTable, encodeCsvDocument(experienceRows), 'utf8');

  await writeFile(paths.mainTable, encodeCsvDocument(mainRows), 'utf8');
  // 记录导出时间：同步时用它区分「导出后新增、表格还没跟上」与「用户真的删了行」
  await writeFile(
    paths.exportMeta,
    `${JSON.stringify({ exportedAt: now.toISOString(), jobCount: jobs.length, experienceCount: experiences.length, version: 2 }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(paths.skillsTable, encodeCsvDocument(skillRows), 'utf8');
  if (!(await fileExists(paths.readme))) await writeFile(paths.readme, README_TEXT, 'utf8');

  if (jobs.length === 0) warnings.push('当前没有岗位；仅生成了表头与说明文件');

  return {
    dir: paths.dir,
    jobCount: jobs.length,
    skillCount: skillRows.length - 1,
    experienceCount: experiences.length,
    files: [paths.mainTable, paths.skillsTable, paths.experiencesTable, paths.readme, paths.rawDir],
    preservedColumns: custom.headers,
    warnings,
  };
}
