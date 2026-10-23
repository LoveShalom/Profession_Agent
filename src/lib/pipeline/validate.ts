/**
 * 抽取结果校验与"待确认"判定（F-02 / T7）
 *
 * 这一层决定三件事：
 *   1. **哪些字段进 needsReview**：置信度 < 0.7、或属于"人工确认字段"、或压根没给置信度；
 *   2. **哪些问题阻塞入库（blocker）**：必填缺失、关键字段有值却无证据；
 *   3. **三态豁免（R-3）**：`deadline` 处于 `text_only`/`absent` 时既不阻塞、也不要求确认。
 *
 * 关键设计：**"抽到值却无证据"才是问题，"JD 本身没写"不是**。
 * 把两者混为一谈会让"不写截止日期的 JD"永远无法入库（这正是 R-3 要修的缺陷）。
 */

import { isFieldId, MANUAL_CONFIRM_FIELD_IDS, type FieldId } from '../schemas/field-dict.ts';
import type { JdExtraction, JdFields } from '../schemas/jd.ts';

/** 规则模式抽不到公司/岗位时的占位值——占位值会被判为 blocker，绝不静默入库 */
export const PLACEHOLDER_COMPANY = '（待填写公司）';
export const PLACEHOLDER_TITLE = '（待填写岗位）';

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export type ValidationBlocker =
  | 'company_missing'
  | 'title_missing'
  | 'raw_text_missing'
  | 'salary_evidence_missing'
  | 'negotiable_evidence_missing'
  | 'deadline_evidence_missing';

export interface ValidateOptions {
  confidenceThreshold?: number;
  /**
   * 用户已人工确认的字段（在确认页改过或勾选过）。
   * 这些字段豁免"有值必须有证据"的阻塞——因为**人已经核对过原文**，
   * 比"模型给的 evidence 字符串"更可靠。这是 AC-2「用户确认后可入库」的实现。
   */
  confirmedFields?: readonly FieldId[];
}

export interface ValidateResult {
  needsReview: FieldId[];
  blockers: ValidationBlocker[];
  /** 无 blocker 即可入库 */
  ok: boolean;
}

/** 这些字段不参与"待确认"（用户不关心/不可编辑） */
const NOT_REVIEWABLE: ReadonlySet<FieldId> = new Set<FieldId>([
  'raw_text',
  'source',
  'source_url',
  'referral_code',
  'is_referral',
]);

const MANUAL_CONFIRM_SET: ReadonlySet<FieldId> = new Set(MANUAL_CONFIRM_FIELD_IDS);

function presentFieldIds(fields: JdFields): FieldId[] {
  const ids: FieldId[] = [];
  if (fields.company) ids.push('company');
  if (fields.title) ids.push('title');
  if (fields.cities.length > 0) ids.push('cities');
  if (fields.job_type !== '未知') ids.push('job_type');
  if (fields.graduation_year !== null) ids.push('graduation_year');
  if (fields.work_mode !== '未知') ids.push('work_mode');
  if (fields.salary_min !== null) ids.push('salary_min');
  if (fields.salary_max !== null) ids.push('salary_max');
  if (fields.salary_months !== null) ids.push('salary_months');
  if (fields.salary_negotiable) ids.push('salary_negotiable');
  if (fields.education !== '未知') ids.push('education');
  if (fields.experience_years !== null) ids.push('experience_years');
  if (fields.skills.length > 0) ids.push('skills');
  if (fields.deadline.kind === 'provided') ids.push('deadline');
  if (fields.deadline_text) ids.push('deadline_text');
  if (fields.channel) ids.push('channel');
  if (fields.source_url) ids.push('source_url');
  return ids;
}

function hasEvidence(extraction: JdExtraction, id: FieldId): boolean {
  const value = extraction.evidence[id];
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 校验抽取结果。
 * @param extraction 已完成默认值填充的抽取结果（JdExtractionSchema 的输出）
 */
export function validateExtraction(extraction: JdExtraction, options: ValidateOptions = {}): ValidateResult {
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const confirmed = new Set<FieldId>(options.confirmedFields ?? []);
  const { fields } = extraction;
  const blockers: ValidationBlocker[] = [];
  const needsReview = new Set<FieldId>(extraction.needsReview.filter((id) => isFieldId(id)));

  // ---------- 1. 必填项（缺失即阻塞） ----------
  if (!fields.company || fields.company === PLACEHOLDER_COMPANY) blockers.push('company_missing');
  if (!fields.title || fields.title === PLACEHOLDER_TITLE) blockers.push('title_missing');
  if (!fields.raw_text) blockers.push('raw_text_missing');

  // ---------- 2. 关键字段：有值必须有证据（人工已确认的除外） ----------
  const salaryConfirmed =
    confirmed.has('salary_min') || confirmed.has('salary_max') || confirmed.has('salary_negotiable');
  const hasSalaryValue = fields.salary_min !== null || fields.salary_max !== null;
  const hasSalaryEvidence = hasEvidence(extraction, 'salary_min') || hasEvidence(extraction, 'salary_max');
  if (hasSalaryValue && !hasSalaryEvidence && !salaryConfirmed) blockers.push('salary_evidence_missing');
  if (
    fields.salary_negotiable &&
    !hasSalaryEvidence &&
    !hasEvidence(extraction, 'salary_negotiable') &&
    !salaryConfirmed
  ) {
    blockers.push('negotiable_evidence_missing');
  }
  // R-3：只有 provided 态才要求证据；text_only / absent 属合法空态
  if (fields.deadline.kind === 'provided' && !hasEvidence(extraction, 'deadline') && !confirmed.has('deadline')) {
    blockers.push('deadline_evidence_missing');
  }

  // ---------- 3. 置信度阈值 + 人工确认字段 → needsReview ----------
  for (const id of presentFieldIds(fields)) {
    if (NOT_REVIEWABLE.has(id)) continue;
    const confidence = extraction.confidence[id];
    const isManual = MANUAL_CONFIRM_SET.has(id);
    // deadline 的人工确认只针对 provided（R-3）
    const manualApplies = isManual && !(id === 'deadline' && fields.deadline.kind !== 'provided');
    if (manualApplies || confidence === undefined || confidence < threshold) needsReview.add(id);
  }

  // 城市是必填但缺失时不阻塞（"全国/多地"是合法情况），只要求确认
  if (fields.cities.length === 0) needsReview.add('cities');

  return {
    needsReview: [...needsReview],
    blockers,
    ok: blockers.length === 0,
  };
}

/** blocker → 面向用户的中文文案（UI 直接展示） */
export const BLOCKER_MESSAGES: Readonly<Record<ValidationBlocker, string>> = {
  company_missing: '公司名称为必填项，请补充后再入库',
  title_missing: '岗位名称为必填项，请补充后再入库',
  raw_text_missing: '缺少 JD 原文，无法入库',
  salary_evidence_missing: '薪资抽到了值但找不到原文依据，请确认或清空',
  negotiable_evidence_missing: '「面议」判断缺少原文依据，请确认',
  deadline_evidence_missing: '截止日期抽到了值但找不到原文依据，请确认或改为"未提供"',
};

export function describeBlockers(blockers: readonly ValidationBlocker[]): string[] {
  return blockers.map((blocker) => BLOCKER_MESSAGES[blocker]);
}
