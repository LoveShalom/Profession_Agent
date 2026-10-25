/**
 * 经历自由文本 → STAR（F-05 T2，AI 归纳 + 规则兜底）
 *
 * 设计要点（与 F-02 的 JD 抽取同构）：
 *   · **有模型时用模型归纳**：合并句子、口语转书面、把"做了 A/B/C"整理成动作清单；
 *   · **无模型时用规则切分**：只按小节标签搬运原文，绝不编造（L4）；
 *   · 两者都经同一份 Zod 契约，且**模型输出会与规则结果互补**（模型漏抽的指标/技能用规则补）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { experienceDedupeKey, extractExperienceFromText, normalizeSkills } from '../pipeline/experience.ts';
import { ExperienceExtractionSchema, type ExperienceExtraction, type Metric } from '../schemas/experience.ts';

import type { ChatMessage, SchemaLike } from './types.ts';
import type { LLMService } from './index.ts';

const FALLBACK_PROMPT = [
  '你是求职经历整理助手。把一段自述整理成 STAR 结构化经历。',
  '只整理不虚构：原文没有的数字、公司、成果一律不许编；允许归纳与改写，但事实必须来自原文。',
  '技能只列原文明确提到的技术名词；指标只抽取原文出现的数字。',
  '只输出一个 JSON：{type,org,role,startDate,endDate,summary,star:{situation,task,action,result},skills,metrics,evidence,confidence}',
].join('\n');

let cachedPrompt: string | null = null;

export function loadExperiencePrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  try {
    const file = path.resolve('prompts/experience-star.md');
    const text = readFileSync(file, 'utf8').trim();
    if (text.length > 0) {
      cachedPrompt = text;
      return text;
    }
  } catch {
    /* 打包环境可能无该文件，走兜底 */
  }
  cachedPrompt = FALLBACK_PROMPT;
  return cachedPrompt;
}

export function buildExperienceMessages(rawText: string, prompt: string = loadExperiencePrompt()): ChatMessage[] {
  return [
    { role: 'system', content: prompt },
    { role: 'user', content: `<experience>\n${rawText.slice(0, 8000)}\n</experience>` },
  ];
}

/** SchemaLike 适配（无 jsonSchema → 走 L1 Prompt-JSON 降级链） */
export const experienceSchemaLike: SchemaLike<ExperienceExtraction> = {
  parse: (input: unknown) => ExperienceExtractionSchema.parse(input),
  safeParse: (input: unknown) => {
    const result = ExperienceExtractionSchema.safeParse(input);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
  },
  describe: () =>
    'JSON 结构：{"type":"internship|project|research|club","org":"","role":null,"startDate":null,"endDate":null,"summary":"","star":{"situation":"","task":"","action":"","result":""},"skills":[],"metrics":[{"metric":"","value":0,"unit":"","raw":""}],"evidence":{},"confidence":0.5}',
};

/** 规则结果与模型结果互补：模型是主，规则补"模型漏掉的硬事实" */
export function mergeExperienceExtraction(
  model: ExperienceExtraction,
  rules: ExperienceExtraction,
): ExperienceExtraction {
  const metrics: Metric[] = [...model.metrics];
  for (const metric of rules.metrics) {
    if (metrics.some((item) => item.unit === metric.unit && item.value === metric.value)) continue;
    metrics.push(metric);
  }
  const skills = normalizeSkills([...model.skills, ...(model.skills.length === 0 ? rules.skills : [])]);
  const star = {
    situation: model.star.situation || '',
    task: model.star.task || '',
    // 模型把 action/result 写空时，用规则的原文片段兜底（而不是留空）
    action: model.star.action || rules.star.action,
    result: model.star.result || rules.star.result,
  };
  return {
    ...model,
    org: model.org || rules.org,
    role: model.role ?? rules.role,
    startDate: model.startDate ?? rules.startDate,
    endDate: model.endDate ?? rules.endDate,
    summary: model.summary || rules.summary,
    star,
    skills,
    metrics: metrics.slice(0, 20),
    evidence: { ...rules.evidence, ...model.evidence },
  };
}

export interface StructuredExperienceResult {
  extraction: ExperienceExtraction;
  engine: 'llm' | 'rules';
  level: string | null;
  degraded: boolean;
  warnings: string[];
  banner?: string;
}

/**
 * 抽取入口：有凭证走模型（L0–L3 由 run 内部降级），无凭证走规则（L4）。
 * 任何异常都退回规则，**不把失败暴露给用户**（与 F-02 一致）。
 */
export async function extractExperienceStructured(params: {
  rawText: string;
  service?: LLMService | null;
}): Promise<StructuredExperienceResult> {
  const rawText = params.rawText.trim();
  const rules = extractExperienceFromText(rawText);
  const warnings: string[] = [];

  const service = params.service ?? null;
  if (!service?.hasCredential) {
    return {
      extraction: rules,
      engine: 'rules',
      level: null,
      degraded: false,
      warnings,
      banner: 'ℹ️ 当前为规则模式：只按小节标签搬运原文，建议保存前手动补全四段。配置模型后会自动归纳。',
    };
  }

  try {
    const result = await service.run<ExperienceExtraction>({
      messages: buildExperienceMessages(rawText),
      schema: experienceSchemaLike,
      rulesFallback: () => rules,
      task: 'extract',
    });
    if (result.status === 'ok' && result.data) {
      const merged = mergeExperienceExtraction(result.data, rules);
      return { extraction: merged, engine: 'llm', level: result.level, degraded: result.degraded, warnings };
    }
    warnings.push('模型未返回可用结构，已回退规则切分');
    return {
      extraction: rules,
      engine: 'rules',
      level: result.level,
      degraded: true,
      warnings,
      ...(result.banner ? { banner: result.banner } : {}),
    };
  } catch (error) {
    warnings.push(`模型调用失败（${error instanceof Error ? error.message : String(error)}），已回退规则切分`);
    return { extraction: rules, engine: 'rules', level: null, degraded: true, warnings };
  }
}

// ---------------------------------------------------------------- 简历整份切分（F-06 + AI）
/**
 * 为什么用模型切分：双栏 PDF 提取出来的文本是乱序的（教育信息跑到标题前、日期挤在句尾、
 * 项目标题和上一段描述粘在同一行）。规则只能靠标签与日期猜，模型能读懂语义边界。
 * 无模型/失败时自动回退规则切分，保证离线可用。
 */
export const RESUME_SEGMENT_PROMPT = [
  '你是简历结构化助手。把整份简历拆成**多段经历**，每段独立。',
  '只输出 JSON：{"experiences":[{type,org,role,startDate,endDate,summary,star:{situation,task,action,result},skills,metrics,evidence,confidence}]}',
  '规则：',
  '1. 只输出 科研/项目/实习/工作/校园 经历；**不要输出教育背景**（本科/硕士/主修课程/GPA 一律忽略）。',
  '2. 个人信息（姓名/手机/邮箱/求职意向）不是经历，忽略。',
  '3. 每个项目/课题/实习独立一段；标题通常是一个名词短语（如“基于多参数磁共振的…研究”），不要把它并进上一段。',
  '4. 日期写 YYYY-MM；只有年份就写 YYYY-01；写“至今”的 endDate 填 null。',
  '5. 只整理不虚构：原文没有的数字与成果不许编；skills 只列原文提到的技术/工具/方法名词。',
  '6. org 认不到就留空字符串（不要猜）。',
].join('\n');

const resumeSegmentSchema: SchemaLike<{ experiences: ExperienceExtraction[] }> = {
  parse: (input: unknown) => {
    const record = input as { experiences?: unknown };
    return { experiences: ExperienceExtractionSchema.array().parse(record.experiences ?? []) };
  },
  safeParse: (input: unknown) => {
    const record = input as { experiences?: unknown };
    const result = ExperienceExtractionSchema.array().safeParse(record.experiences ?? []);
    return result.success ? { success: true, data: { experiences: result.data } } : { success: false, error: "experiences 结构不合法" };
  },
  describe: () => '{"experiences":[{type,org,role,startDate,endDate,summary,star:{situation,task,action,result},skills,metrics,evidence,confidence}]}',
};

export interface ResumeSegmentResult {
  candidates: Array<{ extraction: ExperienceExtraction; rawText: string; dedupeKey: string }>;
  engine: 'llm' | 'rules';
  level: string | null;
  warnings: string[];
}

export async function segmentResumeWithLLM(params: {
  rawText: string;
  service?: LLMService | null;
}): Promise<ResumeSegmentResult> {
  // 规则兜底：动态引入避免与 resume/import 形成循环依赖
  const { segmentExperiences } = await import('../resume/import.ts');
  const rulesResult = (() => {
    try {
      return segmentExperiences(params.rawText);
    } catch {
      return [];
    }
  })();

  const service = params.service ?? null;
  if (!service?.hasCredential || params.rawText.trim().length === 0) {
    return { candidates: rulesResult, engine: 'rules', level: null, warnings: [] };
  }

  try {
    const result = await service.run<{ experiences: ExperienceExtraction[] }>({
      messages: [
        { role: 'system', content: RESUME_SEGMENT_PROMPT },
        { role: 'user', content: `<resume>\n${params.rawText.slice(0, 12000)}\n</resume>` },
      ],
      schema: resumeSegmentSchema,
      rulesFallback: () => ({ experiences: rulesResult.map((item) => item.extraction) }),
      task: 'extract',
    });
    const experiences = result.status === 'ok' && result.data?.experiences ? result.data.experiences : [];
    if (experiences.length === 0) {
      return { candidates: rulesResult, engine: 'rules', level: result.level, warnings: ['模型未切分出经历，已回退规则切分'] };
    }
    const candidates = experiences.slice(0, 30).map((extraction) => {
      const rawText = [extraction.summary, extraction.star.action, extraction.star.result].filter(Boolean).join('\n').slice(0, 2000);
      return { extraction, rawText: rawText || '（模型未返回原文片段）', dedupeKey: experienceDedupeKey(extraction) };
    });
    return { candidates, engine: 'llm', level: result.level, warnings: [] };
  } catch (error) {
    return { candidates: rulesResult, engine: 'rules', level: null, warnings: [`AI 切分失败（${error instanceof Error ? error.message : String(error)}），已回退规则切分`] };
  }
}
