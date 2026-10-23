/**
 * 清洗与分段（F-02 / T3）
 *
 * 抽取质量的一半取决于这一层：JD 是"从招聘网站复制下来的脏文本"——
 * 全角标点、HTML 残留、`<table>` 转出来的制表符、零宽字符、多岗位混贴、提示注入。
 *
 * 设计原则：
 *   - **不改写语义**：只做可逆/无语义的规范化（全半角、空白、标签剥离），不动措辞；
 *   - **保留原文**：`raw_text` 永远是用户给的原串，清洗结果只在管线内流转；
 *   - **不猜**：城市别名只做映射表内的确定性替换；识别不到就是识别不到。
 */

/** 城市别名 → 规范名（确定性映射，不做模糊匹配） */
export const CITY_ALIASES: Readonly<Record<string, string>> = {
  帝都: '北京',
  魔都: '上海',
  鹏城: '深圳',
  羊城: '广州',
  山城: '重庆',
  蓉城: '成都',
  春城: '昆明',
  冰城: '哈尔滨',
  江城: '武汉',
  星城: '长沙',
  金陵: '南京',
  姑苏: '苏州',
  滨城: '大连',
  岛城: '青岛',
  绿城: '郑州',
  洪城: '南昌',
  榕城: '福州',
  羊城广州: '广州',
};

/** 可识别的城市规范名（覆盖面按"校招常见城市"取，未命中不算错误） */
export const KNOWN_CITIES: readonly string[] = [
  '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州',
  '天津', '重庆', '长沙', '郑州', '合肥', '青岛', '济南', '厦门', '福州', '大连',
  '沈阳', '哈尔滨', '昆明', '无锡', '宁波', '佛山', '东莞', '珠海', '南昌', '贵阳',
  '石家庄', '太原', '兰州', '乌鲁木齐', '海口', '南宁', '常州', '温州', '烟台', '嘉兴',
];

export type Language = 'zh' | 'en' | 'other';
export type PiiFlag = 'phone' | 'email' | 'idcard';

export interface CleanText {
  /** 清洗后的全文（≤ 20000 字符） */
  text: string;
  /** 按段落边界切分的分段（每段 ≤ maxSegmentLength） */
  segments: string[];
  language: Language;
  charCount: number;
  piiFlags: PiiFlag[];
  /** 提示注入疑似命中 */
  injectionDetected: boolean;
  warnings: string[];
}

const PII_PATTERNS: ReadonlyArray<{ flag: PiiFlag; pattern: RegExp }> = [
  { flag: 'phone', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { flag: 'email', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { flag: 'idcard', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g },
];

/** 提示注入的典型句式（命中即标记并在 UI 提示，不阻断） */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /忽略(?:以上|上述|前面)(?:的)?(?:所有)?(?:指令|要求|提示|规则)/,
  /忘掉(?:以上|上述|前面)(?:的)?(?:所有)?(?:指令|要求|提示)/,
  /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions?|prompts?|rules?)/i,
  /disregard\s+(?:all\s+)?(?:previous|above)\s+instructions?/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
  /(?:system|assistant)\s*prompt/i,
];

/** 全角 → 半角、统一引号与空白、去零宽字符（NFKC 能覆盖绝大部分全角字符） */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCK_TAG_PATTERN = /<\/?(?:p|div|br|li|ul|ol|tr|h[1-6]|section|article|table|tbody|thead)\b[^>]*>/gi;

/** 剥离 HTML 残留；表格转成 `a | b` 行，块级标签转换行 */
export function stripHtml(input: string): string {
  let text = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(BLOCK_TAG_PATTERN, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return normalizeText(text);
}

export function detectLanguage(input: string): Language {
  const cjk = (input.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (input.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return 'other';
  if (cjk >= 1 && cjk * 4 >= latin) return 'zh'; // 中文占比 ≥20%
  return latin > 0 ? 'en' : 'other';
}

/** 检测 PII（只标记不删除；是否脱敏后发送由调用方决定） */
export function detectPii(input: string): { flags: PiiFlag[]; counts: Record<PiiFlag, number> } {
  const counts: Record<PiiFlag, number> = { phone: 0, email: 0, idcard: 0 };
  for (const { flag, pattern } of PII_PATTERNS) {
    counts[flag] = (input.match(new RegExp(pattern.source, 'g')) ?? []).length;
  }
  const flags = (Object.keys(counts) as PiiFlag[]).filter((flag) => counts[flag] > 0);
  return { flags, counts };
}

/** 对 PII 做打码（用于"脱敏后发送"选项与日志） */
export function maskPii(input: string): string {
  return input
    .replace(PII_PATTERNS[0]!.pattern, (m) => `${m.slice(0, 3)}****${m.slice(-2)}`)
    .replace(PII_PATTERNS[1]!.pattern, (m) => {
      const [user, domain] = m.split('@');
      return `${(user ?? '').slice(0, 1)}***@${domain}`;
    })
    .replace(PII_PATTERNS[2]!.pattern, (m) => `${m.slice(0, 4)}**********${m.slice(-2)}`);
}

export function detectPromptInjection(input: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(input));
}

/** 城市归一：别名先映射，再收集规范名（按首次出现排序、去重） */
export function normalizeCities(input: string): string[] {
  let text = input;
  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
    if (text.includes(alias)) text = text.split(alias).join(` ${canonical} `);
  }
  const found = KNOWN_CITIES.map((city) => ({ city, index: text.indexOf(city) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.city);
  return [...new Set(found)];
}

/**
 * 按段落边界分段：单段 ≤ maxLength；超长段落先按换行、再按标点硬切，
 * 避免把一句话拦腰砍断（会影响抽取质量）。
 */
export function splitSegments(input: string, maxLength = 4000): string[] {
  if (input.length <= maxLength) return input.length > 0 ? [input] : [];

  const paragraphs = input.split(/\n{2,}/);
  const segments: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim().length > 0) segments.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      if (current.length + paragraph.length + 2 > maxLength) flush();
      current += (current ? '\n\n' : '') + paragraph;
      continue;
    }
    // 超长段落：先在换行处切，再按标点硬切
    flush();
    for (const line of paragraph.split('\n')) {
      let rest = line;
      while (rest.length > maxLength) {
        const cut = findCutPoint(rest, maxLength);
        segments.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      if (rest.trim().length === 0) continue;
      if (current.length + rest.length + 1 > maxLength) flush();
      current += (current ? '\n' : '') + rest;
    }
  }
  flush();
  return segments.filter((segment) => segment.length > 0);
}

function findCutPoint(text: string, maxLength: number): number {
  const window = text.slice(0, maxLength);
  const punctuation = /[。！？；.!?;\n]/g;
  let lastIndex = -1;
  for (const match of window.matchAll(punctuation)) lastIndex = match.index ?? lastIndex;
  return lastIndex > maxLength / 2 ? lastIndex + 1 : maxLength;
}

export interface CleanOptions {
  maxLength?: number;
  /** JD 超过该长度直接截断（默认 20000，对应 E_TOO_LONG） */
  hardLimit?: number;
}

/** 清洗主入口：一次调用拿到管线需要的全部信息 */
export function cleanJd(rawInput: string, options: CleanOptions = {}): CleanText {
  const hardLimit = options.hardLimit ?? 20_000;
  const maxLength = options.maxLength ?? 4000;
  const warnings: string[] = [];

  if (rawInput.trim().length === 0) {
    return {
      text: '',
      segments: [],
      language: 'other',
      charCount: 0,
      piiFlags: [],
      injectionDetected: false,
      warnings: ['empty_input'],
    };
  }

  const hadHtml = /<\/?[a-z][^>]*>/i.test(rawInput);
  let text = normalizeText(rawInput);
  if (hadHtml) {
    text = stripHtml(rawInput);
    warnings.push('html_stripped');
  }

  if (text.length > hardLimit) {
    text = text.slice(0, hardLimit);
    warnings.push('truncated_to_hard_limit');
  }

  const { flags: piiFlags } = detectPii(text);
  if (piiFlags.length > 0) warnings.push(`pii_detected:${piiFlags.join(',')}`);

  const injectionDetected = detectPromptInjection(text);
  if (injectionDetected) warnings.push('prompt_injection_suspected');

  const segments = splitSegments(text, maxLength);
  if (segments.length > 1) warnings.push(`split_into_${segments.length}_segments`);

  return {
    text,
    segments,
    language: detectLanguage(text),
    charCount: text.length,
    piiFlags,
    injectionDetected,
    warnings,
  };
}
