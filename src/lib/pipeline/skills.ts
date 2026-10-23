/**
 * 技能属性抽取（F-02 / T19，对应 R-4 裁决）
 *
 * 目标不是"要不要这个技能"，而是回答**"要到什么程度、是不是硬性"**——
 * 这样才能支撑主表三列（明确·必须 / 明确·加分 / 推测）与后续的"先补什么"。
 *
 * 三个正交属性：
 *   source      explicit（JD 明说）/ inferred（领域大类推理，属 F-04 扩展点）
 *   requirement must / nice_to_have / unknown
 *   proficiency expert(精通) / proficient(熟练) / familiar(熟悉) / basic(了解) / unknown
 *
 * 硬约束：**每条技能必须带 `basisPhrase`（原文中的连续片段）**，没有依据就不产出，
 * 而不是给一个猜的 `unknown`——这是"幻觉抑制"在技能维度的落地。
 *
 * R-2（技能图谱 + LLM 补长尾 + 评测）属 F-04；本文件只保留一个**内置领域映射表**作为
 * 可用的最小实现，F-04 会把它替换为 `data/skill-graph.json` + 置信度校准 + 误推率评测。
 */

import type { SkillItem } from '../schemas/jd.ts';

export interface SkillDictEntry {
  name: string;
  aliases?: readonly string[];
}

/** 技能受控词表（显式抽取用；未命中词表的新词进"待审词"，见 C-07） */
export const SKILL_DICT: readonly SkillDictEntry[] = [
  { name: 'Java' },
  { name: 'Python' },
  { name: 'Go' },
  { name: 'C++', aliases: ['C＋＋'] },
  { name: 'TypeScript', aliases: ['TS'] },
  { name: 'JavaScript', aliases: ['JS'] },
  { name: 'React', aliases: ['React.js', 'ReactJS'] },
  { name: 'Vue', aliases: ['Vue.js', 'VueJS', 'Vue3'] },
  { name: 'Node.js', aliases: ['NodeJS', 'Nodejs'] },
  { name: 'Spring', aliases: ['Spring Boot', 'SpringBoot'] },
  { name: 'MySQL' },
  { name: 'PostgreSQL', aliases: ['Postgres', 'PG'] },
  { name: 'Redis' },
  { name: 'Kafka' },
  { name: 'Docker' },
  { name: 'Kubernetes', aliases: ['K8s'] },
  { name: 'Linux' },
  { name: 'Git' },
  { name: 'Nginx' },
  { name: 'Hadoop' },
  { name: 'Spark' },
  { name: 'Flink' },
  { name: 'PyTorch' },
  { name: 'TensorFlow' },
  { name: 'scikit-learn', aliases: ['sklearn'] },
  { name: 'Pandas' },
  { name: 'NumPy' },
  { name: 'SQL' },
  { name: 'Shell', aliases: ['Bash'] },
  { name: 'Ansible' },
  { name: 'Prometheus' },
  { name: 'Selenium' },
  { name: 'JMeter' },
  { name: 'Tableau' },
  { name: 'Figma' },
  { name: 'Axure' },
  { name: '微服务' },
  { name: '分布式' },
  { name: '数据分析' },
];

/**
 * 领域大类 → 可能需要的技术栈（F-04 会替换为外部图谱）。
 * 置信度刻意压低（0.4–0.5）：这是"猜测"，不是"事实"。
 */
export const DOMAIN_SKILL_MAP: Readonly<Record<string, { skills: readonly string[]; confidence: number }>> = {
  深度学习: { skills: ['PyTorch', 'TensorFlow'], confidence: 0.5 },
  机器学习: { skills: ['scikit-learn'], confidence: 0.45 },
  推荐系统: { skills: ['Spark'], confidence: 0.45 },
  大数据: { skills: ['Hadoop', 'Spark', 'Flink'], confidence: 0.45 },
  云原生: { skills: ['Kubernetes', 'Docker', 'Helm'], confidence: 0.5 },
  自动化测试: { skills: ['Selenium', 'JMeter'], confidence: 0.4 },
  数据分析: { skills: ['SQL', 'Pandas', 'Tableau'], confidence: 0.4 },
  运维: { skills: ['Ansible', 'Prometheus', 'Linux'], confidence: 0.4 },
};

/**
 * 刻意**不收录**"前端开发 / 后端开发"这类词：它们是岗位名而不是领域信号，
 * 一个"后端开发工程师"的 JD 会被无差别推出 Spring/MySQL/Redis —— 这正是"误推率"的来源。
 * 宁可少推（漏推由用户手动补），也不要给每个岗位都塞一堆猜测。
 */

export type SkillProficiency = SkillItem['proficiency'];
export type SkillRequirement = SkillItem['requirement'];

/** 熟练度修饰词（顺序即优先级：先匹配到的赢） */
const PROFICIENCY_PATTERNS: ReadonlyArray<{ pattern: RegExp; value: SkillProficiency }> = [
  { pattern: /精通/, value: 'expert' },
  { pattern: /熟练(?:掌握|使用|运用)?/, value: 'proficient' },
  { pattern: /熟悉/, value: 'familiar' },
  { pattern: /了解|知晓/, value: 'basic' },
  { pattern: /掌握/, value: 'familiar' },
];

const MUST_PATTERN = /必须(?:具备|掌握|会|精通|熟悉)?|必备|硬性(?:要求|条件)?/;
const NICE_PATTERN = /优先(?:考虑|录用)?|加分(?:项)?|更佳|更好|尤佳|者优先/;

/** 每份 JD 的推测技能上限（防技能膨胀、防匹配分失真） */
export const MAX_INFERRED = 6;

const PROFICIENCY_WINDOW = 16;
const REQUIREMENT_WINDOW = 24;
const MAX_BASIS = 120;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 短名（≤2 字符，如 Go/PG）区分大小写，避免把英文 "go" 当技能 */
function buildSkillRegex(term: string): RegExp {
  const escaped = escapeRegExp(term);
  const boundaryPrefix = '(?<![A-Za-z0-9+#.])';
  const boundarySuffix = '(?![A-Za-z0-9+#])';
  const flags = term.length <= 2 ? 'g' : 'gi';
  return new RegExp(`${boundaryPrefix}${escaped}${boundarySuffix}`, flags);
}

function detectProficiency(before: string): { value: SkillProficiency; offset: number; modifier: string } | null {
  for (const { pattern, value } of PROFICIENCY_PATTERNS) {
    const match = before.match(pattern);
    if (match && match.index !== undefined) {
      return { value, offset: match.index, modifier: match[0] };
    }
  }
  return null;
}

function detectRequirement(context: string): SkillRequirement {
  if (MUST_PATTERN.test(context)) return 'must';
  if (NICE_PATTERN.test(context)) return 'nice_to_have';
  return 'unknown';
}

function clipBasis(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > MAX_BASIS ? normalized.slice(0, MAX_BASIS) : normalized;
}

/**
 * 抽取 JD **明确写出**的技能（含熟练度与必需性）。
 * 返回项全部 `source='explicit'`，按技能名去重（保留信息量最高的一条）。
 */
export function extractExplicitSkills(text: string): SkillItem[] {
  const byName = new Map<string, SkillItem>();

  for (const entry of SKILL_DICT) {
    const terms = [entry.name, ...(entry.aliases ?? [])];
    for (const term of terms) {
      const regex = buildSkillRegex(term);
      for (const match of text.matchAll(regex)) {
        const index = match.index ?? -1;
        if (index < 0) continue;
        const end = index + match[0].length;
        // 仅在**同一分句内**找熟练度修饰词：否则"了解 Docker；具备 Kubernetes 经验"会把
        // Docker 的"了解"错配给 Kubernetes（跨技能误归属，是技能抽取最常见的精度问题）。
        const beforeRaw = text.slice(Math.max(0, index - PROFICIENCY_WINDOW), index);
        const before = beforeRaw.split(/[，,。；;、\n]/).pop() ?? beforeRaw;
        // 后窗同样必须**限定在同一分句内**：否则 "了解 Docker，具备 Kubernetes 经验优先" 会让
        // Docker 误吃 Kubernetes 的"优先"，把硬性要求降级成加分项。
        const afterRaw = text.slice(end, Math.min(text.length, end + REQUIREMENT_WINDOW));
        const after = afterRaw.split(/[，,。；;、\n]/)[0] ?? '';
        const context = `${before}${match[0]}${after}`;

        const proficiency = detectProficiency(before);
        const requirement = detectRequirement(context);

        // 依据短语必须是原文连续片段（可追溯，反幻觉）；尾部遇到标点即截断，避免把下一个技能卷进来
        const basisStart = proficiency ? Math.max(0, index - (before.length - proficiency.offset)) : index;
        const tail = text.slice(end, Math.min(text.length, end + 8));
        const tailCut = tail.split(/[，,。；;、\n]/)[0] ?? '';
        const basisEnd = end + tailCut.length;
        const basisPhrase = clipBasis(text.slice(basisStart, basisEnd));
        if (basisPhrase.length === 0) continue;

        const confidence = proficiency ? 0.85 : requirement !== 'unknown' ? 0.8 : 0.7;
        const candidate: SkillItem = {
          name: entry.name,
          source: 'explicit',
          requirement,
          proficiency: proficiency?.value ?? 'unknown',
          confidence,
          basisPhrase,
        };

        const key = entry.name.toLowerCase();
        const existing = byName.get(key);
        // 同一技能多次出现：保留"属性信息更多"的一条
        if (!existing || scoreOf(candidate) > scoreOf(existing)) byName.set(key, candidate);
      }
    }
  }

  return [...byName.values()];
}

function scoreOf(item: SkillItem): number {
  let score = 0;
  if (item.proficiency !== 'unknown') score += 2;
  if (item.requirement !== 'unknown') score += 1;
  return score;
}

/**
 * 从领域大类**推测**技能（R-4 / F-04 的最小实现）。
 * 推测项：`proficiency=unknown`（推测只能说明"可能要"，说明不了"要到什么程度"）。
 */
export function inferSkillsFromDomains(text: string, explicit: readonly SkillItem[] = [], limit = MAX_INFERRED): SkillItem[] {
  const explicitNames = new Set(explicit.map((item) => item.name.toLowerCase()));
  const inferred: SkillItem[] = [];
  const seen = new Set<string>();

  for (const [domain, mapping] of Object.entries(DOMAIN_SKILL_MAP)) {
    if (!text.includes(domain)) continue;
    for (const name of mapping.skills) {
      const key = name.toLowerCase();
      if (explicitNames.has(key) || seen.has(key)) continue; // 明说优先，推测不重复
      if (inferred.length >= limit) return inferred;
      seen.add(key);
      inferred.push({
        name,
        source: 'inferred',
        requirement: 'unknown',
        proficiency: 'unknown',
        confidence: mapping.confidence,
        basisPhrase: domain, // 依据就是触发它的领域词（原文存在）
      });
    }
  }
  return inferred;
}

/** 抽取主入口：显式 + 推测（推测上限 6、明说优先、按名去重） */
export function extractSkills(text: string, options: { includeInferred?: boolean; maxInferred?: number } = {}): SkillItem[] {
  const explicit = extractExplicitSkills(text);
  if (options.includeInferred === false) return explicit;
  const inferred = inferSkillsFromDomains(text, explicit, options.maxInferred ?? MAX_INFERRED);
  return [...explicit, ...inferred];
}
