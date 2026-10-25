/**
 * 经历库契约（F-05）
 *
 * 表结构在 0001 已就位（`experiences`）：STAR 四段独立列 + skills + metrics(jsonb)。
 * 这里定义"写入/更新"的 Zod 契约，作为 API 与 UI 的唯一真源。
 */

import { z } from 'zod';

export const EXPERIENCE_TYPES = ['internship', 'project', 'research', 'club'] as const;
export type ExperienceType = (typeof EXPERIENCE_TYPES)[number];

export const EXPERIENCE_TYPE_LABEL: Record<ExperienceType, string> = {
  internship: '实习',
  project: '项目',
  research: '科研',
  club: '社团',
};

/** 量化指标：value 为数字，unit 为原文单位，raw 保留原句便于追溯 */
export const MetricSchema = z.object({
  metric: z.string().trim().max(40),
  value: z.number(),
  unit: z.string().trim().max(16),
  raw: z.string().trim().max(200),
});
export type Metric = z.infer<typeof MetricSchema>;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, '日期格式应为 YYYY-MM 或 YYYY-MM-DD')
  .nullable();

export const ExperienceFormSchema = z
  .object({
    type: z.enum(EXPERIENCE_TYPES),
    org: z.string().trim().min(1, '组织名称必填').max(120),
    role: z.string().trim().max(120).nullable().default(null),
    startDate: dateSchema.default(null),
    endDate: dateSchema.default(null),
    summary: z.string().trim().max(1000).default(''),
    star: z
      .object({
        situation: z.string().trim().max(2000).default(''),
        task: z.string().trim().max(2000).default(''),
        action: z.string().trim().max(4000).default(''),
        result: z.string().trim().max(2000).default(''),
      })
      .default({ situation: '', task: '', action: '', result: '' }),
    skills: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
    metrics: z.array(MetricSchema).max(20).default([]),
    evidenceUrls: z.array(z.string().trim().url()).max(10).default([]),
    rawText: z.string().max(8000).default(''),
  })
  .superRefine((value, ctx) => {
    if (value.startDate && value.endDate && value.endDate < value.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: '结束时间不能早于开始时间' });
    }
    if (value.summary.length === 0 && value.star.action.length === 0 && value.rawText.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['summary'], message: '至少填写摘要、STAR 行动或原始描述之一' });
    }
  });

export type ExperienceForm = z.infer<typeof ExperienceFormSchema>;

/** 自由文本 → STAR 的结构化输出（规则或 LLM 产出，都需要人工确认） */
export const ExperienceExtractionSchema = z.object({
  type: z.enum(EXPERIENCE_TYPES).default('project'),
  org: z.string().trim().max(120).default(''),
  role: z.string().trim().max(120).nullable().default(null),
  startDate: dateSchema.default(null),
  endDate: dateSchema.default(null),
  summary: z.string().trim().max(1000).default(''),
  star: z.object({
    situation: z.string().trim().max(2000).default(''),
    task: z.string().trim().max(2000).default(''),
    action: z.string().trim().max(4000).default(''),
    result: z.string().trim().max(2000).default(''),
  }),
  skills: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  metrics: z.array(MetricSchema).max(20).default([]),
  /** 每个字段的原文依据（与 F-02 的 evidence 同思路） */
  evidence: z.record(z.string(), z.string().max(300)).default({}),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type ExperienceExtraction = z.infer<typeof ExperienceExtractionSchema>;

/** 是否"可用于生成简历"：行动与结果都写了才够格 */
export function isResumeReady(value: Pick<ExperienceForm, 'star'>): boolean {
  return value.star.action.trim().length > 0 && value.star.result.trim().length > 0;
}
