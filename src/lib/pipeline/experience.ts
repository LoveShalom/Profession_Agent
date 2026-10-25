/**
 * 自由文本 → STAR 结构化（F-05 T2，规则模式）
 *
 * 为什么先做规则：无模型时也必须能用（与 F-02 的 L4 一致）；有模型时可作为兜底。
 * 规则能做的事有限但**不编造**：只按关键词把原文切到四段，把原文没写的地方留空。
 */

import { extractSkills } from './skills.ts';

import type { ExperienceExtraction, Metric } from '../schemas/experience.ts';

const SECTION_PATTERNS: Array<{ key: 'situation' | 'task' | 'action' | 'result'; pattern: RegExp }> = [
  { key: 'situation', pattern: /(背景|情境|项目背景|业务背景|situation)/i },
  { key: 'task', pattern: /(任务|目标|职责|挑战|task)/i },
  { key: 'action', pattern: /(行动|做法|方案|实现|负责|action)/i },
  { key: 'result', pattern: /(结果|成果|成效|收益|数据|result)/i },
];

const TYPE_PATTERNS: Array<{ type: ExperienceExtraction['type']; pattern: RegExp }> = [
  { type: 'internship', pattern: /(实习|intern)/i },
  { type: 'research', pattern: /(科研|研究|论文|实验室|paper|research)/i },
  { type: 'club', pattern: /(社团|学生会|club|志愿者)/i },
  { type: 'project', pattern: /(项目|project)/i },
];

/** 量化指标抽取：百分比 / 倍数 / 人数 / 金额 / 耗时；只认有明确数字的说法 */
const METRIC_PATTERNS: Array<{ unit: string; pattern: RegExp; metric: string }> = [
  { unit: '%', pattern: /(\d+(?:\.\d+)?)\s*%/, metric: '提升比例' },
  { unit: '倍', pattern: /(\d+(?:\.\d+)?)\s*倍/, metric: '倍数' },
  { unit: '人', pattern: /(\d+)\s*人/, metric: '人数' },
  { unit: '万', pattern: /(\d+(?:\.\d+)?)\s*万/, metric: '规模(万)' },
  { unit: 'ms', pattern: /(\d+)\s*ms/i, metric: '耗时(ms)' },
  { unit: 's', pattern: /(\d+(?:\.\d+)?)\s*(?:秒|s\b)/, metric: '耗时(秒)' },
];

export function extractMetrics(text: string): Metric[] {
  const metrics: Metric[] = [];
  const sentences = text.split(/[。；;！!？?\n]+/).map((item) => item.trim()).filter(Boolean);
  for (const sentence of sentences) {
    for (const { unit, pattern, metric } of METRIC_PATTERNS) {
      // 同一句里可能同时有「180ms」「30%」「200 万」——每个模式各自找，不互相吞掉
      const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      for (const match of sentence.matchAll(regex)) {
        const value = Number(match[1]);
        if (!Number.isFinite(value)) continue;
        const duplicate = metrics.some((item) => item.unit === unit && item.value === value);
        if (duplicate) continue;
        metrics.push({ metric, value, unit, raw: sentence.slice(0, 200) });
        if (metrics.length >= 20) break;
      }
    }
  }
  return metrics.slice(0, 20);
}

/** 从文本里认组织名：优先"在 X 公司/实验室/社团"这类结构，认不到就留空（不猜） */
export function extractOrg(text: string): string {
  const patterns = [
    /(?:在|于)\s*([\u4e00-\u9fa5A-Za-z0-9（）()·&]{2,30}(?:股份有限公司|有限责任公司|有限公司|公司|集团|科技|实验室|研究院|银行|证券|大学|学院|社团|学生会))/,
    /^([\u4e00-\u9fa5A-Za-z0-9（）()·&]{2,30}(?:股份有限公司|有限责任公司|有限公司|公司|集团|科技|实验室|研究院|银行|证券))/m,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

export function extractRole(text: string): string | null {
  const match = /(?:担任|职位[:：]?|岗位[:：]?|角色[:：]?)\s*([\u4e00-\u9fa5A-Za-z0-9（）()·/]{2,30})/.exec(text);
  return match?.[1]?.trim() ?? null;
}

/** 从文本中识别 YYYY-MM / YYYY年M月 */
export function extractDates(text: string): { startDate: string | null; endDate: string | null } {
  const dates: string[] = [];
  for (const match of text.matchAll(/(20\d{2})\s*[年\-/.]\s*(\d{1,2})/g)) {
    const month = String(Number(match[2])).padStart(2, '0');
    const value = `${match[1]}-${month}`;
    if (!dates.includes(value)) dates.push(value);
  }
  dates.sort();
  return { startDate: dates[0] ?? null, endDate: dates.length > 1 ? dates[dates.length - 1]! : null };
}

function detectType(text: string): ExperienceExtraction['type'] {
  for (const { type, pattern } of TYPE_PATTERNS) if (pattern.test(text)) return type;
  return 'project';
}

/**
 * 规则版 STAR 抽取：
 *   · 先按"关键词小节"切分（背景/任务/行动/结果）；
 *   · 找不到小节标记时，把原文整体作为 action（**不编造**四段内容）。
 */
export function extractExperienceFromText(rawText: string): ExperienceExtraction {
  // 真实简历常把标签写在句子中间（"参与订单系统开发。背景：大促频繁超时。"），
  // 先在这些位置插入换行，让后面的逐行解析能识别到小节。
  const text = rawText
    .trim()
    .replace(/([。；;])\s*(背景|情境|项目背景|业务背景|任务|目标|职责|挑战|行动|做法|方案|实现|结果|成果|成效|收益)\s*[:：]/g, '$1\n$2：');
  const evidence: Record<string, string> = {};
  const star = { situation: '', task: '', action: '', result: '' };

  // 逐行解析：同时支持「背景：正文」（同行）与「背景：」换行接正文两种写法。
  // 旧实现只认"标签独占一行"，导致真实简历里最常见的同行写法完全识别不到。
  const labelPattern = /^\s*(背景|情境|项目背景|业务背景|任务|目标|职责|挑战|行动|做法|方案|实现|结果|成果|成效|收益)\s*[:：]?\s*(.*)$/;
  const buckets: Record<'situation' | 'task' | 'action' | 'result', string[]> = {
    situation: [],
    task: [],
    action: [],
    result: [],
  };
  let currentKey: 'situation' | 'task' | 'action' | 'result' | null = null;

  for (const line of text.split(/\r?\n/)) {
    const matched = labelPattern.exec(line);
    if (matched) {
      currentKey = SECTION_PATTERNS.find((item) => item.pattern.test(matched[1]!))?.key ?? currentKey;
      const inline = (matched[2] ?? '').trim();
      if (currentKey && inline.length > 0) buckets[currentKey].push(inline);
      continue;
    }
    if (currentKey) buckets[currentKey].push(line);
  }

  for (const key of ['situation', 'task', 'action', 'result'] as const) {
    const body = buckets[key].join('\n').trim();
    if (body.length === 0) continue;
    star[key] = body;
    evidence[key] = body.slice(0, 200);
  }

  if (!star.action && !star.result && !star.situation && !star.task) {
    star.action = text.slice(0, 4000);
    evidence['action'] = '原文整体（未识别到小节标记）';
  }

  const skills = extractSkills(text).map((item) => item.name);
  const metrics = extractMetrics(text);
  const dates = extractDates(text);
  const org = extractOrg(text);
  const summary = text.split(/[。\n]/)[0]?.slice(0, 120) ?? '';

  const fieldsPresent = [star.situation, star.task, star.action, star.result, org].filter((item) => item.length > 0).length;
  const confidence = Math.min(0.95, 0.3 + fieldsPresent * 0.12 + (skills.length > 0 ? 0.05 : 0) + (metrics.length > 0 ? 0.05 : 0));

  return {
    type: detectType(text),
    org,
    role: extractRole(text),
    startDate: dates.startDate,
    endDate: dates.endDate,
    summary,
    star,
    skills,
    metrics,
    evidence,
    confidence: Number(confidence.toFixed(2)),
  };
}

/**
 * 技能归一：模型常把两个技能合并成一个字符串（"SQL 缓存"、"Redis、MySQL"）。
 * 这里只做「明确的分隔」拆分，不猜同义词：
 *   · 中文分隔符（、，；/|）直接拆；
 *   · 「拉丁字母/数字 + 空格 + 中文」或反向也拆（SQL 缓存 → SQL / 缓存）；
 *   · 拉丁词之间的空格保留（Spring Boot、Node.js 不拆）。
 */
export function normalizeSkills(skills: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of skills) {
    const parts = raw
      .split(/[、，,；;|]+/)
      .flatMap((piece) => piece.split(/(?<=[A-Za-z0-9+#.])\s+(?=[\u4e00-\u9fa5])|(?<=[\u4e00-\u9fa5])\s+(?=[A-Za-z0-9+#.])/))
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0);
    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(part);
    }
  }
  return out.slice(0, 50);
}

/** 去重键：同组织 + 同角色 + 同起始月视为重复（与 F-02 的指纹思路一致） */
export function experienceDedupeKey(input: {
  org: string;
  role?: string | null;
  startDate?: string | null;
  /** 无机构/无角色时（如科研课题、课程项目）用摘要区分，避免多条被判重复 */
  summary?: string | null;
}): string {
  const org = input.org.trim().toLowerCase().replace(/\s+/g, '');
  const role = (input.role ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const start = (input.startDate ?? '').slice(0, 7);
  const fallback = org.length === 0 && role.length === 0 ? (input.summary ?? '').trim().toLowerCase().slice(0, 24) : '';
  return `${org}|${role}|${start}|${fallback}`;
}
