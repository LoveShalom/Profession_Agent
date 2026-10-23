/**
 * 字段字典 v1 的运行时契约（F-02 / T2）
 *
 * 三件事在这一层收敛：
 *   1. **Zod schema**：校验 LLM 输出与入库前的数据（唯一权威校验器）；
 *   2. **JSON Schema**：喂给 tool calling 的结构约束（只是"提示"，最终以 Zod 为准）；
 *   3. **SchemaLike 适配**：让 F-01 的 `run()` 能直接用（含 schema 修复重试）。
 *
 * 为什么 JSON Schema 手写而不是自动生成：zod 3.x 没有内置 `toJSONSchema`，
 * 引入 `zod-to-json-schema` 会多一个依赖；字段字典是**固定的 18 字段**，手写更可控
 * （能给每个字段写中文 description，提升 tool calling 质量）。
 * 代价是两份定义可能漂移 → 由 `tests/jd-schema.test.ts` 做**一致性测试**兜住。
 */

import { z } from 'zod';

import type { SchemaLike } from '../llm/types.ts';
import { FIELD_IDS, type FieldId } from './field-dict.ts';

// ---------------------------------------------------------------- 枚举
export const JOB_TYPE_VALUES = ['校招', '社招', '实习', '提前批', '未知'] as const;
export const WORK_MODE_VALUES = ['onsite', 'hybrid', 'remote', '未知'] as const;
export const EDUCATION_VALUES = ['不限', '大专', '本科', '硕士', '博士', '未知'] as const;
export const SOURCE_VALUES = ['manual', 'guopin', 'ncss', 'resume_import', 'plugin'] as const;

/** R-4：技能来源 */
export const SKILL_SOURCE_VALUES = ['explicit', 'inferred'] as const;
/** R-4：技能必需性（与熟练度正交） */
export const SKILL_REQUIREMENT_VALUES = ['must', 'nice_to_have', 'unknown'] as const;
/** R-4：技能熟练度（中文 JD 的四档 + 未标注） */
export const SKILL_PROFICIENCY_VALUES = ['expert', 'proficient', 'familiar', 'basic', 'unknown'] as const;
/** R-3：截止时间三态 */
export const DEADLINE_KIND_VALUES = ['provided', 'text_only', 'absent'] as const;

// ---------------------------------------------------------------- 技能
export const SkillItemSchema = z.object({
  name: z.string().trim().min(1).max(40),
  source: z.enum(SKILL_SOURCE_VALUES),
  requirement: z.enum(SKILL_REQUIREMENT_VALUES),
  proficiency: z.enum(SKILL_PROFICIENCY_VALUES),
  confidence: z.number().min(0).max(1),
  /** 触发该技能的原文短语；无依据不允许出现（幻觉抑制） */
  basisPhrase: z.string().trim().min(1).max(120),
});

export type SkillItem = z.infer<typeof SkillItemSchema>;

// ---------------------------------------------------------------- 截止时间（R-3 三态）
export const DeadlineSchema = z
  .object({
    kind: z.enum(DEADLINE_KIND_VALUES),
    /** ISO8601 带时区，如 "2026-11-20T23:59:59+08:00" */
    at: z.string().datetime({ offset: true }).nullable(),
    text: z.string().trim().max(200).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'provided' && !value.at) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'kind=provided 时 at 必填（ISO8601 带时区）' });
    }
    if (value.kind === 'text_only' && !value.text) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'kind=text_only 时 text 必填（原文表述）' });
    }
    if (value.kind === 'absent' && (value.at !== null || value.text !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'kind=absent 时 at/text 必须为 null' });
    }
  });

export type Deadline = z.infer<typeof DeadlineSchema>;

/** 合法的"无截止日期"值——JD 没写截止日期时用它，不是错误 */
export const ABSENT_DEADLINE: Deadline = { kind: 'absent', at: null, text: null };

// ---------------------------------------------------------------- 经验年限
export const ExperienceYearsSchema = z
  .object({
    min: z.number().int().min(0).max(60).nullable(),
    max: z.number().int().min(0).max(60).nullable(),
    unlimited: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (!value.unlimited && value.min === null && value.max === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '需给出 min/max 或 unlimited=true' });
    }
    if (!value.unlimited && value.min !== null && value.max !== null && value.max < value.min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'max 不能小于 min' });
    }
  });

export type ExperienceYears = z.infer<typeof ExperienceYearsSchema>;

// ---------------------------------------------------------------- 字段集合
export const JdFieldsSchema = z
  .object({
    // 必填（1 / 2 / 5 / 17 / 18）
    company: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    cities: z.array(z.string().trim().min(1).max(20)).max(10).default([]),
    source: z.enum(SOURCE_VALUES).default('manual'),
    raw_text: z.string().min(1),

    // 可选
    job_type: z.enum(JOB_TYPE_VALUES).default('未知'),
    graduation_year: z.number().int().min(2000).max(2100).nullable().default(null),
    work_mode: z.enum(WORK_MODE_VALUES).default('未知'),
    salary_min: z.number().int().min(0).max(1_000_000).nullable().default(null),
    salary_max: z.number().int().min(0).max(1_000_000).nullable().default(null),
    salary_months: z.number().int().min(1).max(36).nullable().default(null),
    salary_negotiable: z.boolean().default(false),
    education: z.enum(EDUCATION_VALUES).default('未知'),
    experience_years: ExperienceYearsSchema.nullable().default(null),
    skills: z.array(SkillItemSchema).max(40).default([]),
    deadline: DeadlineSchema.default(ABSENT_DEADLINE),
    deadline_text: z.string().trim().max(200).nullable().default(null),
    channel: z.string().trim().max(40).nullable().default(null),
    is_referral: z.boolean().default(false),
    referral_code: z.string().trim().max(40).nullable().default(null),
    source_url: z.string().url().max(2000).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    // G-02：组合字段整组校验
    if (value.salary_min !== null && value.salary_max !== null && value.salary_max < value.salary_min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['salary_max'], message: '薪资上限不能小于下限' });
    }
    // 字典 #9：面议时 min/max 必须置空
    if (value.salary_negotiable && (value.salary_min !== null || value.salary_max !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['salary_negotiable'],
        message: 'salary_negotiable=true 时 salary_min/salary_max 必须为 null',
      });
    }
    // 技能去重：同一 (name, source) 不允许重复（对应 job_skills 唯一约束）
    const seen = new Set<string>();
    value.skills.forEach((item, index) => {
      const key = `${item.source}::${item.name.toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skills', index, 'name'], message: `技能重复：${item.name}（${item.source}）` });
      }
      seen.add(key);
    });
    // 推测技能必须有依据短语（冗余校验，防绕过 SkillItemSchema）
    value.skills.forEach((item, index) => {
      if (item.source === 'inferred' && item.basisPhrase.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skills', index, 'basisPhrase'], message: '推测技能必须给出依据短语' });
      }
    });
  });

export type JdFields = z.infer<typeof JdFieldsSchema>;

// ---------------------------------------------------------------- 抽取信封（LLM 输出结构）
const FieldIdEnum = z.enum(FIELD_IDS as [FieldId, ...FieldId[]]);

export const JdExtractionSchema = z.object({
  fields: JdFieldsSchema,
  /** 字段 → 原文片段（抽到值的字段必须有证据） */
  evidence: z.record(FieldIdEnum, z.string().max(500).nullable()).default({}),
  /** 字段 → 置信度 0–1 */
  confidence: z.record(FieldIdEnum, z.number().min(0).max(1)).default({}),
  /** 需要人工确认的字段 */
  needsReview: z.array(FieldIdEnum).default([]),
});

export type JdExtraction = z.infer<typeof JdExtractionSchema>;

// ---------------------------------------------------------------- JSON Schema（喂 tool calling）
const NULLABLE_STRING = { type: ['string', 'null'] } as const;
const NULLABLE_INT = { type: ['integer', 'null'] } as const;

const SKILL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'source', 'requirement', 'proficiency', 'confidence', 'basisPhrase'],
  properties: {
    name: { type: 'string', description: '技能名，如 Java / Kubernetes' },
    source: {
      type: 'string',
      enum: [...SKILL_SOURCE_VALUES],
      description: 'explicit=JD 明确写的；inferred=JD 只给领域大类、由推理得出的',
    },
    requirement: {
      type: 'string',
      enum: [...SKILL_REQUIREMENT_VALUES],
      description: 'must=硬性要求；nice_to_have=优先/加分；unknown=无法判断',
    },
    proficiency: {
      type: 'string',
      enum: [...SKILL_PROFICIENCY_VALUES],
      description: 'expert=精通；proficient=熟练；familiar=熟悉；basic=了解；unknown=未标注',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    basisPhrase: { type: 'string', description: '触发该技能的原文短语（必须来自 JD 原文）' },
  },
} as const;

export const JD_FIELDS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['company', 'title', 'cities', 'source', 'raw_text', 'deadline', 'skills'],
  properties: {
    company: { type: 'string', description: '公司全名；保留原始后缀' },
    title: { type: 'string', description: '岗位名称；保留原值' },
    cities: { type: 'array', items: { type: 'string' }, description: '工作城市（已归一）；"全国/多地"返回空数组' },
    source: { type: 'string', enum: [...SOURCE_VALUES] },
    raw_text: { type: 'string', description: 'JD 原文，永不改写' },
    job_type: { type: 'string', enum: [...JOB_TYPE_VALUES] },
    graduation_year: { ...NULLABLE_INT, description: '"2027届" → 2027' },
    work_mode: { type: 'string', enum: [...WORK_MODE_VALUES] },
    salary_min: { ...NULLABLE_INT, description: '元/月；"15k" → 15000' },
    salary_max: { ...NULLABLE_INT, description: '元/月；年薪需换算为月' },
    salary_months: { ...NULLABLE_INT, description: '"14薪" → 14' },
    salary_negotiable: { type: 'boolean', description: '面议=true，此时 min/max 必须为 null' },
    education: { type: 'string', enum: [...EDUCATION_VALUES] },
    experience_years: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['min', 'max', 'unlimited'],
      properties: { min: NULLABLE_INT, max: NULLABLE_INT, unlimited: { type: 'boolean' } },
    },
    skills: { type: 'array', maxItems: 40, items: SKILL_JSON_SCHEMA },
    deadline: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'at', 'text'],
      description:
        '三态：provided=有明确日期(at 必填)；text_only=只有模糊表述(text 必填)；absent=JD 完全没提截止日期(合法状态，两者为 null)',
      properties: {
        kind: { type: 'string', enum: [...DEADLINE_KIND_VALUES] },
        at: { ...NULLABLE_STRING, description: 'ISO8601 带时区，如 2026-11-20T23:59:59+08:00' },
        text: NULLABLE_STRING,
      },
    },
    deadline_text: { ...NULLABLE_STRING, description: '截止日期原文片段' },
    channel: NULLABLE_STRING,
    is_referral: { type: 'boolean' },
    referral_code: NULLABLE_STRING,
    source_url: { ...NULLABLE_STRING, description: '岗位链接' },
  },
} as const;

export const JD_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'evidence', 'confidence', 'needsReview'],
  properties: {
    fields: JD_FIELDS_JSON_SCHEMA,
    evidence: {
      type: 'object',
      description: '字段名 → 支撑该字段的原文短语；抽到值的字段必须有',
      additionalProperties: NULLABLE_STRING,
    },
    confidence: {
      type: 'object',
      description: '字段名 → 0–1 置信度',
      additionalProperties: { type: 'number', minimum: 0, maximum: 1 },
    },
    needsReview: { type: 'array', items: { type: 'string', enum: [...FIELD_IDS] } },
  },
} as const;

// ---------------------------------------------------------------- ZodError → 可读错误（喂修复重试）
export function formatZodIssues(error: z.ZodError, maxLength = 800): string {
  const lines = error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  if (error.issues.length > 12) lines.push(`… 另有 ${error.issues.length - 12} 处问题`);
  const text = lines.join('; ');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * 把任意 Zod schema 适配成 F-01 的 SchemaLike 契约。
 * 注意 Input 用 unknown：schema 带 `.default()` 时输入/输出类型不同，
 * 用 `z.ZodType<T>`（默认 Input=Output）会类型不兼容。
 */
export function toSchemaLike<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  jsonSchema: Record<string, unknown>,
  description: string,
): SchemaLike<T> {
  return {
    parse: (input: unknown) => schema.parse(input),
    safeParse: (input: unknown) => {
      const result = schema.safeParse(input);
      if (result.success) return { success: true, data: result.data };
      return { success: false, error: formatZodIssues(result.error) };
    },
    jsonSchema,
    describe: () => description,
  };
}

export const jdExtractionSchemaLike: SchemaLike<JdExtraction> = toSchemaLike(
  JdExtractionSchema,
  JD_EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
  [
    '从一段招聘 JD 中抽取 18 个字段。',
    '要求：① 抽到值的字段必须在 evidence 里给出原文短语；② 不确定的字段放进 needsReview；',
    '③ skills 每项必须带 basisPhrase；JD 只给领域大类（如"深度学习"）时可给出 source=inferred 的技能；',
    '④ 截止时间三态：JD 没写就用 kind=absent，不要编造日期。',
  ].join(''),
);

// ---------------------------------------------------------------- 技能分列（R-5）
const PROFICIENCY_LABEL: Record<(typeof SKILL_PROFICIENCY_VALUES)[number], string> = {
  expert: '精通',
  proficient: '熟练',
  familiar: '熟悉',
  basic: '了解',
  unknown: '',
};

/**
 * 把结构化技能渲染成主表的 3 列（R-5 分列方案，零依赖、可筛选）。
 * - `技能·明确(必须)`：explicit + must，附熟练度
 * - `技能·明确(加分)`：explicit + nice_to_have/unknown
 * - `技能·推测`：inferred，附「置信度←依据短语」
 */
export function splitSkillColumns(skills: readonly SkillItem[]): {
  explicitMust: string;
  explicitNice: string;
  inferred: string;
} {
  const withProficiency = (item: SkillItem): string => {
    const label = PROFICIENCY_LABEL[item.proficiency];
    return label ? `${item.name}(${label})` : item.name;
  };
  const explicitMust = skills.filter((s) => s.source === 'explicit' && s.requirement === 'must').map(withProficiency);
  const explicitNice = skills
    .filter((s) => s.source === 'explicit' && s.requirement !== 'must')
    .map(withProficiency);
  const inferred = skills
    .filter((s) => s.source === 'inferred')
    .map((s) => `${s.name}(${s.confidence.toFixed(1)}←"${s.basisPhrase}")`);

  return {
    explicitMust: explicitMust.join(';'),
    explicitNice: explicitNice.join(';'),
    inferred: inferred.join(';'),
  };
}
