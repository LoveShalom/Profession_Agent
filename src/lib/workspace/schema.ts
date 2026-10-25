/**
 * 主表列定义与行映射（F-03 T1/T2）
 *
 * 这里是「表格列 ↔ 数据库字段」的**唯一真源**：
 *   · 导出按 `MAIN_COLUMNS` 顺序写；
 *   · 同步按同一份定义解析，只接受标为 `editable` 的列；
 *   · 只读列被手改时不采纳（下次导出会恢复），并记录 warning。
 */

import type { JobRecord } from '../db/types.ts';
import type { JobSkillRow } from '../jobs/mapping.ts';
import type { SkillItem } from '../schemas/jd.ts';

/** 技能三属性别名（直接从字段契约推导，避免与 jd.ts 重复定义） */
export type SkillProficiency = SkillItem['proficiency'];
export type SkillRequirement = SkillItem['requirement'];

export type ColumnKind = 'readonly' | 'editable' | 'skills';

export interface MainColumn {
  header: string;
  kind: ColumnKind;
  /** editable 列对应的 DB 字段（用于生成 JobPatch） */
  field?: string;
  /** skills 列对应的 requirement */
  requirement?: SkillRequirement;
}

/** 主表 24 列（顺序即 CSV 列顺序） */
export const MAIN_COLUMNS: readonly MainColumn[] = [
  { header: '岗位ID', kind: 'readonly' },
  { header: '_rev', kind: 'readonly' },
  { header: '公司', kind: 'editable', field: 'company' },
  { header: '岗位', kind: 'editable', field: 'title' },
  { header: '城市', kind: 'editable', field: 'cities' },
  { header: '招聘类型', kind: 'editable', field: 'job_type' },
  { header: '届别', kind: 'editable', field: 'graduation_year' },
  { header: '学历', kind: 'editable', field: 'education' },
  { header: '经验', kind: 'readonly' },
  { header: '薪资下限', kind: 'editable', field: 'salary_min' },
  { header: '薪资上限', kind: 'editable', field: 'salary_max' },
  { header: '薪资月数', kind: 'editable', field: 'salary_months' },
  { header: '截止时间', kind: 'editable', field: 'deadline' },
  { header: '截止类型', kind: 'readonly' },
  { header: '技能·明确(必须)', kind: 'skills', requirement: 'must' },
  { header: '技能·明确(加分)', kind: 'skills', requirement: 'nice_to_have' },
  { header: '技能·推测', kind: 'readonly' },
  { header: '状态', kind: 'editable', field: 'status' },
  { header: '优先级', kind: 'editable', field: 'priority' },
  { header: '下一步', kind: 'editable', field: 'nextAction' },
  { header: '下一步时间', kind: 'editable', field: 'nextActionAt' },
  { header: '备注', kind: 'editable', field: 'notes' },
  { header: '待确认字段', kind: 'readonly' },
  { header: '剩余天数', kind: 'readonly' },
];

export const MAIN_HEADERS: readonly string[] = MAIN_COLUMNS.map((column) => column.header);

/** 技能明细表（长表，只读） */
export const SKILL_HEADERS: readonly string[] = ['岗位ID', '公司', '岗位', '技能', '来源', '必需性', '熟练度', '置信度', '原文依据'];

export const SKILL_SOURCE_LABEL: Record<JobSkillRow['source'], string> = {
  explicit: '明确',
  inferred: '推测',
};

export const REQUIREMENT_LABEL: Record<SkillRequirement, string> = {
  must: '必须',
  nice_to_have: '加分',
  unknown: '未标注',
};

export const PROFICIENCY_LABEL: Record<SkillProficiency, string> = {
  expert: '精通',
  proficient: '熟练',
  familiar: '熟悉',
  basic: '了解',
  unknown: '',
};

const PROFICIENCY_REVERSE: Record<string, SkillProficiency> = {
  精通: 'expert',
  熟练: 'proficient',
  熟悉: 'familiar',
  了解: 'basic',
};

// ---------------------------------------------------------------- 导出格式化
function num(value: number | null): string {
  return value === null || value === undefined ? '' : String(value);
}

export function formatCities(cities: readonly string[]): string {
  return cities.join(' / ');
}

export function formatDeadline(job: JobRecord): string {
  if (job.deadline_kind !== 'provided' || !job.deadline) return '';
  return job.deadline.slice(0, 10);
}

/** 剩余天数（只读计算列）：负数表示已过期 */
export function daysRemaining(job: JobRecord, now: Date = new Date()): string {
  if (job.deadline_kind !== 'provided' || !job.deadline) return '';
  const diff = new Date(job.deadline).getTime() - now.getTime();
  return String(Math.ceil(diff / 86_400_000));
}

export function formatSkillCell(row: JobSkillRow): string {
  const label = PROFICIENCY_LABEL[row.proficiency];
  return label ? `${row.skill}(${label})` : row.skill;
}

/** 一行岗位 → 一个 CSV 行 */
export function jobToRow(job: JobRecord, skills: readonly JobSkillRow[], now: Date = new Date()): string[] {
  const explicit = skills.filter((row) => row.source === 'explicit');
  const inferred = skills.filter((row) => row.source === 'inferred');
  return [
    job.id,
    String(job.revision),
    job.company,
    job.title,
    formatCities(job.cities),
    job.job_type,
    num(job.graduation_year),
    job.education,
    job.experience_years ? JSON.stringify(job.experience_years) : '',
    num(job.salary_min),
    num(job.salary_max),
    num(job.salary_months),
    formatDeadline(job),
    job.deadline_kind,
    explicit
      .filter((row) => row.requirement === 'must')
      .map(formatSkillCell)
      .join('; '),
    explicit
      .filter((row) => row.requirement !== 'must')
      .map(formatSkillCell)
      .join('; '),
    inferred
      .map((row) => `${row.skill}(${row.confidence.toFixed(2)}←${row.basisPhrase})`)
      .join('; '),
    job.status,
    job.priority,
    job.nextAction ?? '',
    job.nextActionAt ? job.nextActionAt.slice(0, 10) : '',
    job.notes,
    [...job.review_flags].join(', '),
    daysRemaining(job, now),
  ];
}

// ---------------------------------------------------------------- 同步解析
/** 把单元格拆成技能列表：`Java(精通); MySQL` → `[{name:'Java',proficiency:'expert'}, {name:'MySQL',proficiency:'unknown'}]` */
export function parseSkillCell(cell: string): Array<{ name: string; proficiency: SkillProficiency }> {
  return cell
    .split(/[;；,，、\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const match = /^(.*?)[（(]([^）)]*)[）)]$/.exec(item);
      if (!match) return { name: item, proficiency: 'unknown' as SkillProficiency };
      const label = match[2]!.trim();
      return { name: match[1]!.trim(), proficiency: PROFICIENCY_REVERSE[label] ?? 'unknown' };
    })
    .filter((item) => item.name.length > 0);
}

/** 解析数字单元格：容忍 `15,000`、`15k`、`15K/月`、全角数字 */
export function parseNumberCell(cell: string): number | null {
  const text = cell.trim().replace(/，/g, ',').replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  if (text.length === 0) return null;
  const thousands = text.match(/^([\d,]+)\s*[kK]$/);
  if (thousands) return Number(thousands[1]!.replace(/,/g, '')) * 1000;
  const plain = text.replace(/,/g, '').match(/-?\d+/);
  if (!plain) return null;
  return Number(plain[0]);
}

/** 解析城市：`上海 / 杭州`、`上海、杭州`、`上海;杭州` */
export function parseCitiesCell(cell: string): string[] {
  return cell
    .split(/[/;；,，、|\s]+/)
    .map((city) => city.trim())
    .filter((city) => city.length > 0 && city !== '—' && city !== '-');
}

/** 解析日期：`2026-11-20`、`2026/11/20`、`2026年11月20日`、ISO 全串 */
export function parseDateCell(cell: string): string | null {
  const text = cell.trim();
  if (text.length === 0 || text === '—' || text === '-') return null;
  const normalized = text.replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** 表格行 → 索引（用于按列名取值，容忍用户调整列顺序） */
export function headerIndex(header: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((name, index) => {
    const key = name.trim();
    if (!map.has(key)) map.set(key, index);
  });
  return map;
}

/** 字段变化时应当从「待确认」里移除的 flags（人工校准即视为已确认） */
export function reviewFlagsClearedBy(field: string): string[] {
  switch (field) {
    case 'company':
      return ['company'];
    case 'title':
      return ['title'];
    case 'cities':
      return ['cities'];
    case 'job_type':
      return ['job_type'];
    case 'graduation_year':
      return ['graduation_year'];
    case 'education':
      return ['education'];
    case 'salary_min':
    case 'salary_max':
    case 'salary_months':
      return ['salary_min', 'salary_max', 'salary_months', 'salary_negotiable'];
    case 'deadline':
      return ['deadline', 'deadline_text'];
    default:
      return [];
  }
}
