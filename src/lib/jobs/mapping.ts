/**
 * 抽取结果 → 入库记录（F-02 / T9 映射层）
 *
 * 这一层只做**纯函数映射**（不碰 IO），因此可以完整单测：
 *   JdExtraction + ValidateResult  →  JobDraft（jobs 一等列）+ JobSkillRow[]（job_skills）
 *
 * 几个刻意的取舍：
 *   · `status` 默认 `saved`（C-01 裁决：确认页可标 `to_apply`，避免一入库就进"待投递"）；
 *   · `skills` 数组保留"归一化名集合"（explicit + inferred 去重），供索引与粗筛；
 *     属性的真相在 `job_skills` 表；
 *   · `jd_structured` 只存 evidence / confidence / needsReview 与版本号——
 *     一等列是唯一真源（G-05），不要把结构化结果再复制一份；
 *   · `deadline_kind` 与 `deadline` 成对写入，DB 侧有 CHECK 约束兜底。
 */

import { buildFingerprint } from '../pipeline/dedupe.ts';
import type { ValidateResult } from '../pipeline/validate.ts';
import type { FieldId } from '../schemas/field-dict.ts';
import type { ExperienceYears, JdExtraction, SkillItem } from '../schemas/jd.ts';

export const FIELD_DICT_VERSION = 'field-dict-v1';

/** jobs 表一等列（与 0001/0003 migration 对齐） */
export interface JobDraft {
  company: string;
  title: string;
  job_type: string;
  graduation_year: number | null;
  city: string | null;
  cities: string[];
  work_mode: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_months: number | null;
  salary_negotiable: boolean;
  education: string;
  experience_years: ExperienceYears | null;
  skills: string[];
  deadline: string | null;
  deadline_kind: 'provided' | 'text_only' | 'absent';
  deadline_text: string | null;
  source: string;
  source_url: string | null;
  channel: string | null;
  is_referral: boolean;
  referral_code: string | null;
  raw_text: string;
  jd_structured: Record<string, unknown>;
  review_flags: FieldId[];
  fingerprint: string;
  status: 'saved';
  priority: '中';
}

/** job_skills 表一行 */
export interface JobSkillRow {
  skill: string;
  source: SkillItem['source'];
  requirement: SkillItem['requirement'];
  proficiency: SkillItem['proficiency'];
  confidence: number;
  basisPhrase: string;
  ruleId: string | null;
}

/** 技能名去重后的归一化集合（供 jobs.skills 索引/粗筛） */
export function collectSkillNames(skills: readonly SkillItem[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of skills) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(item.name);
  }
  return names;
}

/** 抽取结果 + 校验结果 → jobs 一等列 */
export function toJobDraft(extraction: JdExtraction, validation: ValidateResult): JobDraft {
  const fields = extraction.fields;
  const fingerprint = buildFingerprint({ company: fields.company, title: fields.title, cities: fields.cities });

  return {
    company: fields.company,
    title: fields.title,
    job_type: fields.job_type,
    graduation_year: fields.graduation_year,
    city: fields.cities[0] ?? null,
    cities: fields.cities,
    work_mode: fields.work_mode,
    salary_min: fields.salary_min,
    salary_max: fields.salary_max,
    salary_months: fields.salary_months,
    salary_negotiable: fields.salary_negotiable,
    education: fields.education,
    experience_years: fields.experience_years,
    skills: collectSkillNames(fields.skills),
    deadline: fields.deadline.kind === 'provided' ? fields.deadline.at : null,
    deadline_kind: fields.deadline.kind,
    deadline_text: fields.deadline_text,
    source: fields.source,
    source_url: fields.source_url,
    channel: fields.channel,
    is_referral: fields.is_referral,
    referral_code: fields.referral_code,
    raw_text: fields.raw_text,
    jd_structured: {
      schemaVersion: FIELD_DICT_VERSION,
      evidence: extraction.evidence,
      confidence: extraction.confidence,
      needsReview: extraction.needsReview,
    },
    review_flags: validation.needsReview,
    fingerprint,
    status: 'saved',
    priority: '中',
  };
}

/** 抽取结果 → job_skills 行（一行一个技能；explicit 与 inferred 各自一行） */
export function toJobSkillRows(extraction: JdExtraction): JobSkillRow[] {
  return extraction.fields.skills.map((item) => ({
    skill: item.name,
    source: item.source,
    requirement: item.requirement,
    proficiency: item.proficiency,
    confidence: item.confidence,
    basisPhrase: item.basisPhrase,
    ruleId: null,
  }));
}
