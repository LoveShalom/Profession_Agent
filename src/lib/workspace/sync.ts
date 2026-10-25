/**
 * 工作区同步（F-03 T2）——把用户在 Excel 里的修改写回数据库
 *
 * 五条铁律（对应 AC-2 ~ AC-5）：
 *   1. **只采纳可改列**：只读列被改 → 不生效 + warning（下次导出恢复）；
 *   2. **用户优先**：文件 `_rev` 落后于库时仍采用用户值，但写入冲突记录；
 *   3. **删行不删数据**：文件里没有的岗位一律保留（重导出会补回），只计数提示；
 *   4. **同步前备份**：`.backup/` 保留最近 5 份，可手工回滚；
 *   5. **乐观并发**：更新时带 `expectedRevision`，并发改动只会让本次跳过而不会覆盖。
 */

import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { JobPatch, JobRepository } from '../db/types.ts';
import type { JobDraft, JobSkillRow } from '../jobs/mapping.ts';
import { buildFingerprint } from '../pipeline/dedupe.ts';
import type { FieldId } from '../schemas/field-dict.ts';
import type { SkillItem } from '../schemas/jd.ts';

type SkillProficiency = SkillItem['proficiency'];

import { encodeCsvDocument, parseCsv } from './csv.ts';
import { workspacePaths } from './paths.ts';
import {
  MAIN_COLUMNS,
  headerIndex,
  parseCitiesCell,
  parseDateCell,
  parseNumberCell,
  parseSkillCell,
  reviewFlagsClearedBy,
} from './schema.ts';

export interface SyncReport {
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  deletedProtected: number;
  /** 导出之后才新增的岗位（不是删行，只是表格还没跟上） */
  notYetExported: number;
  warnings: string[];
  /** 逐条变更摘要（便于在 UI/终端展示） */
  changes: string[];
  backup?: string;
  dryRun: boolean;
}

interface ConflictEntry {
  jobId: string;
  company: string;
  title: string;
  field: string;
  fileValue: string;
  dbValue: string;
  note: string;
}

const CONFLICT_HEADERS = ['时间', '岗位ID', '公司', '岗位', '字段', '表格值', '数据库值', '说明'];

function cell(row: readonly string[], index: number | undefined): string {
  if (index === undefined) return '';
  return (row[index] ?? '').trim();
}

/** 文件值与数据库值是否等价由各字段的解析器负责（数字/城市/日期按语义比） */

async function backup(mainTable: string, backupDir: string, now: Date): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(backupDir, `岗位管理表.${stamp}.csv`);
  await copyFile(mainTable, target);

  // 只保留最近 5 份
  const files = (await readdir(backupDir)).filter((name) => name.startsWith('岗位管理表.')).sort();
  for (const stale of files.slice(0, Math.max(0, files.length - 5))) {
    await unlink(path.join(backupDir, stale)).catch(() => undefined);
  }
  return target;
}

/** 新行 → 最小可入库草稿（表格里新增的岗位没有原文，必须显式标注） */
function draftFromCells(values: Record<string, string>, now: Date): JobDraft | null {
  const company = values['company']?.trim() ?? '';
  const title = values['title']?.trim() ?? '';
  if (company.length === 0 || title.length === 0) return null;

  const cities = parseCitiesCell(values['cities'] ?? '');
  const deadlineIso = parseDateCell(values['deadline'] ?? '');
  return {
    company,
    title,
    job_type: values['job_type']?.trim() || '其他',
    graduation_year: parseNumberCell(values['graduation_year'] ?? ''),
    city: cities[0] ?? null,
    cities,
    work_mode: 'unknown',
    salary_min: parseNumberCell(values['salary_min'] ?? ''),
    salary_max: parseNumberCell(values['salary_max'] ?? ''),
    salary_months: parseNumberCell(values['salary_months'] ?? ''),
    salary_negotiable: false,
    education: values['education']?.trim() || 'unknown',
    experience_years: null,
    skills: [],
    deadline: deadlineIso,
    deadline_kind: deadlineIso ? 'provided' : 'absent',
    deadline_text: null,
    source: 'manual',
    source_url: null,
    channel: 'workspace',
    is_referral: false,
    referral_code: null,
    raw_text: '（该岗位由用户在工作区表格中新增，没有原文快照）',
    jd_structured: { schemaVersion: 'field-dict-v1', createdFrom: 'workspace', createdAt: now.toISOString() },
    review_flags: [],
    fingerprint: buildFingerprint({ company, title, cities }),
    status: 'saved',
    priority: '中',
  };
}

function skillsToRows(parsed: Array<{ name: string; proficiency: SkillProficiency }>, requirement: 'must' | 'nice_to_have' | 'unknown', existing: readonly JobSkillRow[]): JobSkillRow[] {
  return parsed.map((item) => {
    const previous = existing.find((row) => row.skill.toLowerCase() === item.name.toLowerCase());
    return {
      skill: item.name,
      source: 'explicit' as const,
      requirement,
      proficiency: item.proficiency,
      confidence: 1,
      // 人工校准的技能没有模型依据，用显式标记代替空串（DB 约束要求非空）
      basisPhrase: previous?.basisPhrase ?? '（工作区人工校准）',
      ruleId: previous?.ruleId ?? null,
    };
  });
}

export async function syncWorkspace(
  repo: JobRepository,
  userId: string,
  options: { dir?: string; now?: Date; dryRun?: boolean } = {},
): Promise<SyncReport> {
  const paths = workspacePaths(options.dir);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const report: SyncReport = {
    created: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
    deletedProtected: 0,
    notYetExported: 0,
    warnings: [],
    changes: [],
    dryRun,
  };

  let content: string;
  try {
    content = await readFile(paths.mainTable, 'utf8');
  } catch {
    report.warnings.push(`找不到台账文件：${paths.mainTable}（先运行 npm run workspace:export）`);
    return report;
  }

  const parsed = parseCsv(content);
  report.warnings.push(...parsed.warnings);
  const header = parsed.rows[0];
  if (!header) {
    report.warnings.push('台账为空（连表头都没有）');
    return report;
  }

  const index = headerIndex(header);
  if (!index.has('岗位ID')) {
    report.warnings.push('表头缺少「岗位ID」列，已拒绝同步（防止误把别的表当台账）');
    return report;
  }

  const conflicts: ConflictEntry[] = [];
  const existingJobs = await repo.list(userId, { limit: 1000 });
  const seenIds = new Set<string>();
  let backupPath: string | undefined;

  if (!dryRun) backupPath = await backup(paths.mainTable, paths.backupDir, now);
  report.backup = backupPath;

  /** 字段名 → 表格列名（冲突记录写给用户看，必须是中文列名） */
  const headerOf = (field: string): string => MAIN_COLUMNS.find((item) => item.field === field)?.header ?? field;

  for (const row of parsed.rows.slice(1)) {
    const id = cell(row, index.get('岗位ID'));

    const readField = (field: string): string => {
      const column = MAIN_COLUMNS.find((item) => item.field === field);
      return column ? cell(row, index.get(column.header)) : '';
    };

    /** 表格里的新行 → 入库（需要公司+岗位；重复指纹跳过） */
    const createFromRow = async (): Promise<void> => {
      const draft = draftFromCells(
        {
          company: readField('company'),
          title: readField('title'),
          cities: readField('cities'),
          job_type: readField('job_type'),
          graduation_year: readField('graduation_year'),
          education: readField('education'),
          salary_min: readField('salary_min'),
          salary_max: readField('salary_max'),
          salary_months: readField('salary_months'),
          deadline: readField('deadline'),
        },
        now,
      );
      if (!draft) {
        report.skipped += 1;
        report.warnings.push(`新增行缺少公司或岗位，已跳过（岗位ID=${id || '（空）'}）`);
        return;
      }
      if (dryRun) {
        report.created += 1;
        report.changes.push(`将新增：${draft.company} / ${draft.title}`);
        return;
      }
      const duplicate = await repo.findByFingerprint(userId, draft.fingerprint);
      if (duplicate) {
        report.skipped += 1;
        report.warnings.push(`新增行与已有岗位重复（${draft.company} / ${draft.title}），已跳过`);
        return;
      }
      await repo.insert(userId, draft, []);
      report.created += 1;
      report.changes.push(`新增：${draft.company} / ${draft.title}`);
    };

    // 没有岗位ID = 用户在 Excel 里新加的行
    if (id.length === 0) {
      await createFromRow();
      continue;
    }

    seenIds.add(id);

    const job = existingJobs.find((item) => item.id === id) ?? (await repo.findById(userId, id));
    if (!job) {
      // 有 ID 但库里没有（例如数据库被重建）→ 也按新增处理
      await createFromRow();
      continue;
    }

    const fileRevision = parseNumberCell(cell(row, index.get('_rev'))) ?? 0;
    const patch: JobPatch = {};
    const changedFields: string[] = [];

    const applyNumber = (field: 'salary_min' | 'salary_max' | 'salary_months' | 'graduation_year', current: number | null) => {
      const next = parseNumberCell(readField(field));
      if (next !== current) {
        (patch as Record<string, unknown>)[field] = next;
        changedFields.push(field);
      }
    };

    const company = readField('company');
    if (company.length > 0 && company !== job.company) {
      patch.company = company;
      changedFields.push('company');
    }
    const title = readField('title');
    if (title.length > 0 && title !== job.title) {
      patch.title = title;
      changedFields.push('title');
    }
    const citiesCell = readField('cities');
    if (citiesCell.length > 0 || job.cities.length > 0) {
      const next = parseCitiesCell(citiesCell);
      if (JSON.stringify(next) !== JSON.stringify(job.cities)) {
        patch.cities = next;
        changedFields.push('cities');
      }
    }
    const jobType = readField('job_type');
    if (jobType.length > 0 && jobType !== job.job_type) {
      patch.job_type = jobType;
      changedFields.push('job_type');
    }
    const education = readField('education');
    if (education.length > 0 && education !== job.education) {
      patch.education = education;
      changedFields.push('education');
    }
    applyNumber('graduation_year', job.graduation_year);
    applyNumber('salary_min', job.salary_min);
    applyNumber('salary_max', job.salary_max);
    applyNumber('salary_months', job.salary_months);

    // 截止时间：空 = 未提供（absent）；有值 = provided
    // 只比"日期部分"——表格里只有 `2026-11-20`，而数据库存的是当天的 23:59:59，
    // 按全量 ISO 比较会把每次同步都误判成"改过了"（往返不幂等）。
    const deadlineCell = readField('deadline');
    const nextDeadlineDate = parseDateCell(deadlineCell);
    const currentDeadlineDate = job.deadline ? job.deadline.slice(0, 10) : null;
    const nextDateOnly = nextDeadlineDate ? nextDeadlineDate.slice(0, 10) : null;
    if (nextDateOnly !== currentDeadlineDate) {
      patch.deadline = nextDateOnly ? new Date(`${nextDateOnly}T23:59:59+08:00`).toISOString() : null;
      patch.deadline_kind = nextDateOnly ? 'provided' : 'absent';
      patch.deadline_text = nextDateOnly ? job.deadline_text : null;
      changedFields.push('deadline');
    }

    // 状态机三列 + 备注
    // 状态/优先级：空单元格视为「未填」，不覆盖库内值（避免误清空）
    for (const field of ['status', 'priority'] as const) {
      const value = readField(field);
      const current = String((job as unknown as Record<string, unknown>)[field] ?? '');
      if (value.length > 0 && value !== current) {
        (patch as unknown as Record<string, unknown>)[field] = value;
        changedFields.push(field);
      }
    }
    // 备注：允许清空（用户把备注删掉是明确意图）
    const notesValue = readField('notes');
    if (notesValue !== job.notes) {
      patch.notes = notesValue;
      changedFields.push('notes');
    }
    const nextAction = readField('nextAction');
    if (nextAction !== (job.nextAction ?? '')) {
      patch.nextAction = nextAction.length > 0 ? nextAction : null;
      changedFields.push('nextAction');
    }
    // 只比日期部分：表格列只有 `2026-11-01`，库里可能带时分秒；按全量 ISO 比较会每次误判
    const nextActionAtParsed = parseDateCell(readField('nextActionAt'));
    const nextActionAtDate = nextActionAtParsed ? nextActionAtParsed.slice(0, 10) : null;
    const currentNextActionDate = job.nextActionAt ? job.nextActionAt.slice(0, 10) : null;
    if (nextActionAtDate !== currentNextActionDate) {
      patch.nextActionAt = nextActionAtDate ? new Date(`${nextActionAtDate}T09:00:00+08:00`).toISOString() : null;
      changedFields.push('nextActionAt');
    }

    // 技能列（明确·必须 / 明确·加分）
    const skills = await repo.listSkills(job.id);
    const explicit = skills.filter((row) => row.source === 'explicit');
    const currentMust = explicit
      .filter((row) => row.requirement === 'must')
      .map((row) => row.skill)
      .sort();
    const currentNice = explicit
      .filter((row) => row.requirement !== 'must')
      .map((row) => row.skill)
      .sort();
    const mustColumn = index.get('技能·明确(必须)');
    const niceColumn = index.get('技能·明确(加分)');
    const mustCell = cell(row, mustColumn);
    const niceCell = cell(row, niceColumn);
    const wantMust = mustCell.length > 0 ? parseSkillCell(mustCell) : [];
    const wantNice = niceCell.length > 0 ? parseSkillCell(niceCell) : [];
    const skillsChanged =
      JSON.stringify(wantMust.map((item) => item.name).sort()) !== JSON.stringify(currentMust) ||
      JSON.stringify(wantNice.map((item) => item.name).sort()) !== JSON.stringify(currentNice);

    if (changedFields.length === 0 && !skillsChanged) continue;

    // 冲突：文件版本落后于库，但仍采用用户值（铁律 2）
    if (changedFields.length > 0 && fileRevision < job.revision) {
      report.conflicts += 1;
      for (const field of changedFields) {
        conflicts.push({
          jobId: job.id,
          company: job.company,
          title: job.title,
          field: headerOf(field),
          fileValue: String((patch as Record<string, unknown>)[field] ?? ''),
          dbValue: String((job as unknown as Record<string, unknown>)[field] ?? ''),
          note: `表格修订号 ${fileRevision} < 库修订号 ${job.revision}；已采用表格值`,
        });
      }
    }

    // 人工校准即视为确认：把对应字段从待确认里移除
    const cleared = new Set<string>();
    for (const field of changedFields) for (const flag of reviewFlagsClearedBy(field)) cleared.add(flag);
    if (cleared.size > 0) {
      const nextFlags = job.review_flags.filter((flag: FieldId) => !cleared.has(flag));
      if (nextFlags.length !== job.review_flags.length) patch.review_flags = nextFlags;
    }

    if (dryRun) {
      report.updated += 1;
      report.changes.push(`将更新：${job.company} / ${job.title}（${changedFields.join(', ')}${skillsChanged ? ', 技能' : ''}）`);
      continue;
    }

    const updated = await repo.update(userId, job.id, { ...patch, expectedRevision: job.revision });
    if (!updated) {
      report.skipped += 1;
      report.warnings.push(`并发修改导致跳过：${job.company} / ${job.title}`);
      continue;
    }

    if (skillsChanged) {
      const rows = [
        ...skillsToRows(wantMust, 'must', skills),
        ...skillsToRows(wantNice, 'nice_to_have', skills),
      ];
      await repo.replaceExplicitSkills(userId, job.id, rows);
    }

    report.updated += 1;
    report.changes.push(`更新：${job.company} / ${job.title}（${changedFields.join(', ') || '技能'}）`);
  }

  // 库里有、表里没有：要区分两种情况，否则会把「表格过期」误报成「用户删了行」
  //   a) 岗位是在上次导出之后才新增的 → 属正常，重新导出即可纳入（notYetExported）
  //   b) 岗位在导出时就存在、现在表里没了 → 用户确实删了行（deletedProtected，不删数据）
  let exportedAt: Date | null = null;
  try {
    const meta = JSON.parse(await readFile(paths.exportMeta, 'utf8')) as { exportedAt?: string };
    if (meta.exportedAt) exportedAt = new Date(meta.exportedAt);
  } catch {
    /* 没有元数据（老版本导出的）→ 退回用文件修改时间 */
  }
  if (!exportedAt) {
    try {
      exportedAt = (await stat(paths.mainTable)).mtime;
    } catch {
      exportedAt = null;
    }
  }

  for (const job of existingJobs) {
    if (seenIds.has(job.id)) continue;
    const createdAt = new Date(job.createdAt);
    const isNewSinceExport = exportedAt !== null && createdAt.getTime() > exportedAt.getTime();
    if (isNewSinceExport) report.notYetExported += 1;
    else report.deletedProtected += 1;
  }
  if (report.notYetExported > 0) {
    report.warnings.push(
      `有 ${report.notYetExported} 个岗位是在上次导出之后新增的（未出现在台账里）——重新导出即可纳入，不是数据丢失`,
    );
  }
  if (report.deletedProtected > 0) {
    report.warnings.push(`检测到 ${report.deletedProtected} 个岗位在台账中被删除；为安全起见未删除数据（重新导出即可恢复）`);
  }

  if (conflicts.length > 0 && !dryRun) {
    const rows = [CONFLICT_HEADERS, ...conflicts.map((entry) => [now.toISOString(), entry.jobId, entry.company, entry.title, entry.field, entry.fileValue, entry.dbValue, entry.note])];
    const previous = await readFile(paths.conflicts, 'utf8').catch(() => '');
    const previousRows = previous ? parseCsv(previous).rows.slice(1) : [];
    await writeFile(paths.conflicts, encodeCsvDocument([CONFLICT_HEADERS, ...previousRows, ...rows.slice(1)]), 'utf8');
  }

  return report;
}
