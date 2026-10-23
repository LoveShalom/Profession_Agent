/**
 * 规则抽取器（I0 / T5 的 L3–L4 降级路径）
 *
 * 存在意义（F-01 §1.3-C）：当没有 API Key（L4）或上游不可用（L3）时，系统**不能白屏或报错**，
 * 而要给出"能用的最小结果 + 全部标记待确认"。这也是"无密钥可用"（AC-6）的实现。
 *
 * 设计取舍：这里只做零依赖的确定性规则（正则 + 词典），不追求准确率；
 * 所有输出字段一律进 needsReview，confidence 上限 0.6（< 0.7 阈值），
 * 确保用户知道"这些值需要人工确认"。
 */

export interface RuleFieldSpec {
  id: string;
  label: string;
}

export interface RuleExtractResult {
  fields: Record<string, unknown>;
  evidence: Record<string, string | null>;
  confidence: Record<string, number>;
  needsReview: string[];
  /** 命中规则数量，便于 UI 说明"规则模式识别到 N 个字段" */
  matched: number;
}

const CITY_LIST = [
  '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州', '天津', '重庆',
  '长沙', '郑州', '合肥', '青岛', '济南', '厦门', '福州', '大连', '沈阳', '哈尔滨', '昆明', '无锡',
  '宁波', '佛山', '东莞', '珠海', '南昌', '贵阳', '石家庄', '太原', '兰州', '乌鲁木齐', '海口', '南宁',
];

const EDUCATION_MAP: Array<[RegExp, string]> = [
  [/博士|phd/i, '博士'],
  [/硕士|研究生|master/i, '硕士'],
  [/本科|学士|bachelor/i, '本科'],
  [/大专|专科/, '大专'],
  [/学历不限|不限学历/, '不限'],
];

const JOB_TYPE_MAP: Array<[RegExp, string]> = [
  [/实习|intern/i, '实习'],
  [/提前批/, '提前批'],
  [/校招|校园招聘|应届/, '校招'],
  [/社招|社会招聘/, '社招'],
];

const SKILL_SEED: Array<[RegExp, string]> = [
  [/\bJava\b/i, 'Java'],
  [/\bPython\b/i, 'Python'],
  [/\bGo\b|Golang/i, 'Go'],
  [/\bC\+\+|C\+\+11/i, 'C++'],
  [/\bTypeScript\b|\bTS\b/, 'TypeScript'],
  [/\bJavaScript\b|\bJS\b/, 'JavaScript'],
  [/\bReact\b/i, 'React'],
  [/\bVue\b/i, 'Vue'],
  [/\bNode\.?js\b/i, 'Node.js'],
  [/\bMySQL\b/i, 'MySQL'],
  [/\bPostgreSQL\b|\bPostgres\b/i, 'PostgreSQL'],
  [/\bRedis\b/i, 'Redis'],
  [/\bKafka\b/i, 'Kafka'],
  [/\bDocker\b/i, 'Docker'],
  [/\bKubernetes\b|\bK8s\b/i, 'Kubernetes'],
  [/\bSQL\b/i, 'SQL'],
  [/机器学习|Machine Learning|\bML\b/i, '机器学习'],
  [/深度学习|Deep Learning/i, '深度学习'],
  [/\bLLM\b|大模型|大语言模型/i, '大模型'],
  [/\bRAG\b/i, 'RAG'],
  [/数据分析/i, '数据分析'],
  [/\bAxure\b/i, 'Axure'],
  [/\bFigma\b/i, 'Figma'],
  [/项目管理/i, '项目管理'],
];

/** 全角转半角 + 去多余空白（规则抽取的自有最小归一化，避免依赖 F-02 的清洗模块） */
export function normalizeText(input: string): string {
  return input
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function round(n: number): number {
  return Math.round(n);
}

export interface SalaryParse {
  salary_min?: number;
  salary_max?: number;
  salary_months?: number;
  salary_negotiable?: boolean;
  evidence: string;
}

/** 解析薪资：15k-25k / 15-25K / 20k以上 / 20-35万/年 / 25万 / 面议 */
export function parseSalary(text: string): SalaryParse | null {
  if (/面议|薪资面谈|待遇面议/.test(text)) {
    return { salary_negotiable: true, evidence: '面议' };
  }
  const monthsMatch = text.match(/(\d{2})\s*薪/);
  const months = monthsMatch ? Number(monthsMatch[1]) : undefined;

  // k 形式：15k-25k / 15-25K / 15K～25K / 20k以上
  const kRange = text.match(/(\d{1,3})\s*[kK]\s*[-~至到]\s*(\d{1,3})\s*[kK]/);
  if (kRange) {
    return {
      salary_min: Number(kRange[1]) * 1000,
      salary_max: Number(kRange[2]) * 1000,
      salary_months: months,
      evidence: kRange[0],
    };
  }
  const kSingle = text.match(/(\d{1,3})\s*[kK]\s*(以上|起|\+)/);
  if (kSingle) {
    return { salary_min: Number(kSingle[1]) * 1000, salary_months: months, evidence: kSingle[0] };
  }
  // 万/年 形式：20-35万/年、年薪 30 万
  const wanRange = text.match(/(\d{1,3})\s*[-~至到]\s*(\d{1,3})\s*万/);
  if (wanRange) {
    return {
      salary_min: round((Number(wanRange[1]) * 10000) / 12),
      salary_max: round((Number(wanRange[2]) * 10000) / 12),
      salary_months: months,
      evidence: wanRange[0],
    };
  }
  const wanSingle = text.match(/(?:年薪|年包)?\s*(\d{1,3})\s*万/);
  if (wanSingle) {
    return { salary_min: round((Number(wanSingle[1]) * 10000) / 12), salary_months: months, evidence: wanSingle[0] };
  }
  // 纯数字月薪：15000-25000 / 15000元
  const plainRange = text.match(/(\d{4,6})\s*[-~至到]\s*(\d{4,6})/);
  if (plainRange) {
    return { salary_min: Number(plainRange[1]), salary_max: Number(plainRange[2]), salary_months: months, evidence: plainRange[0] };
  }
  if (months) return { salary_months: months, evidence: monthsMatch![0] };
  return null;
}

/** 解析截止时间：2026-11-20 / 2026/11/20 / 2026年11月20日 / 11月20日前（按当前年） */
export function parseDeadline(text: string, now: Date = new Date()): { deadline: string; evidence: string } | null {
  const iso = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return { deadline: toEndOfDayIso(Number(y), Number(m), Number(d)), evidence: iso[0] };
  }
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (monthDay) {
    const year = now.getFullYear();
    return { deadline: toEndOfDayIso(year, Number(monthDay[1]), Number(monthDay[2])), evidence: monthDay[0] };
  }
  return null;
}

/** 仅日期 → 当日 23:59:59+08:00（口径见 tech_stack §9.2.0） */
export function toEndOfDayIso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const yy = String(year).padStart(4, '0');
  return `${yy}-${mm}-${dd}T23:59:59+08:00`;
}

/** 规则抽取主入口：返回字段 + 证据 + 置信度 + 全部待确认字段 */
export function extractWithRules(rawText: string, now: Date = new Date()): RuleExtractResult {
  const text = normalizeText(rawText);
  const fields: Record<string, unknown> = {};
  const evidence: Record<string, string | null> = {};
  const confidence: Record<string, number> = {};

  const set = (id: string, value: unknown, ev: string | null, conf: number) => {
    if (value === undefined || value === null || value === '') return;
    fields[id] = value;
    evidence[id] = ev;
    confidence[id] = conf;
  };

  // 公司名：匹配"XX有限公司/科技/集团"等，置信度低
  const company = text.match(/([\u4e00-\u9fa5A-Za-z0-9（）()]{2,30}(?:有限公司|股份有限公司|集团|科技|研究院|银行|证券))/);
  if (company) set('company', company[1], company[0], 0.4);

  // 岗位名：常见后缀
  const title = text.match(/([\u4e00-\u9fa5A-Za-z]{2,20}(?:工程师|开发|设计师|产品经理|运营|分析师|研究员|实习生|架构师))/);
  if (title) set('title', title[1], title[0], 0.4);

  // 城市：取全部命中
  const cities = CITY_LIST.filter((city) => text.includes(city));
  if (cities.length > 0) set('cities', cities, cities.join('/'), 0.5);

  // 薪资
  const salary = parseSalary(text);
  if (salary) {
    if (salary.salary_min !== undefined) set('salary_min', salary.salary_min, salary.evidence, 0.5);
    if (salary.salary_max !== undefined) set('salary_max', salary.salary_max, salary.evidence, 0.5);
    if (salary.salary_months !== undefined) set('salary_months', salary.salary_months, salary.evidence, 0.5);
    if (salary.salary_negotiable) set('salary_negotiable', true, salary.evidence, 0.6);
  }

  // 学历 / 招聘类型 / 届别 / 经验
  for (const [re, value] of EDUCATION_MAP) {
    const hit = text.match(re);
    if (hit) {
      set('education', value, hit[0], 0.55);
      break;
    }
  }
  for (const [re, value] of JOB_TYPE_MAP) {
    const hit = text.match(re);
    if (hit) {
      set('job_type', value, hit[0], 0.5);
      break;
    }
  }
  const gradYear = text.match(/(20\d{2})\s*届/);
  if (gradYear) set('graduation_year', Number(gradYear[1]), gradYear[0], 0.6);

  const expRange = text.match(/(\d{1,2})\s*[-~至到]\s*(\d{1,2})\s*年/);
  const expSingle = text.match(/(\d{1,2})\s*年以上/);
  const expUnlimited = /经验不限|不限经验/.test(text);
  if (expRange) {
    set('experience_years', { min: Number(expRange[1]), max: Number(expRange[2]), unlimited: false }, expRange[0], 0.55);
  } else if (expSingle) {
    set('experience_years', { min: Number(expSingle[1]), unlimited: false }, expSingle[0], 0.5);
  } else if (expUnlimited) {
    set('experience_years', { unlimited: true }, '经验不限', 0.6);
  }

  // 技能：词典命中
  const skills = SKILL_SEED.filter(([re]) => re.test(text)).map(([, name]) => name);
  if (skills.length > 0) set('skills', [...new Set(skills)], skills.join('/'), 0.5);

  // 截止时间
  const deadline = parseDeadline(text, now);
  if (deadline) set('deadline', deadline.deadline, deadline.evidence, 0.55);

  // 来源与原文
  set('source', 'manual', null, 1);
  set('raw_text', rawText, null, 1);

  const matched = Object.keys(fields).length;
  // 规则模式：所有非原文/来源字段一律待确认（用户必须复核）
  const needsReview = Object.keys(fields).filter((id) => id !== 'raw_text' && id !== 'source');

  return { fields, evidence, confidence, needsReview, matched };
}
