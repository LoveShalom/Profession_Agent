/**
 * 评测评分（F-09 / I4 T2）—— 纯函数，便于穷举测试
 *
 * 设计取舍：
 *   · **字段级判定**而不是整条 pass/fail：公司名对了、技能漏两个，应该部分得分；
 *   · 城市/技能用 **set F1**（漏一个扣分但不归零）；
 *   · 截止日期分两段：`kind` 必须一致；`provided` 时再比日期；
 *   · 空值语义：gold 为空 → 该字段 `na`（不参与宏平均），避免"猜空=对"刷分。
 */

export type FieldId = 'company' | 'title' | 'cities' | 'deadline' | 'salary' | 'skills';

export interface GoldLikely {
  company: string | null;
  title: string | null;
  cities: string[];
  deadline_kind: 'provided' | 'text_only' | 'absent';
  deadline_at: string | null;
  salary_min: number | null;
  salary_max: number | null;
  skills: string[];
}

export interface PredLike extends GoldLikely {}

export type FieldScore = number | null; // null = 不适用（gold 为空）

export interface ItemScore {
  perField: Record<FieldId, FieldScore>;
  macro: number;
}

const COMPANY_NOISE = /(有限责任公司|股份有限公司|有限公司|公司|集团|控股|科技|技术|网络|信息|股份)/g;

export function normalizeCompany(value: string | null): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[\s·（）()【】\[\]]/g, '').replace(COMPANY_NOISE, '');
}

export function normalizeTitle(value: string | null): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[\s·（）()【】/、,，-]/g, '');
}

function textMatch(gold: string | null, pred: string | null): FieldScore {
  const g = normalizeCompany(gold);
  if (g.length === 0) return null;
  const p = normalizeCompany(pred);
  if (p.length === 0) return 0;
  return g === p || g.includes(p) || p.includes(g) ? 1 : 0;
}

function titleMatch(gold: string | null, pred: string | null): FieldScore {
  const g = normalizeTitle(gold);
  if (g.length === 0) return null;
  const p = normalizeTitle(pred);
  if (p.length === 0) return 0;
  return g === p || g.includes(p) || p.includes(g) ? 1 : 0;
}

/** 集合 F1（大小写/空格归一） */
export function setF1(gold: readonly string[], pred: readonly string[]): number {
  const g = new Set(gold.map((item) => item.toLowerCase().replace(/\s/g, '').trim()).filter(Boolean));
  const p = new Set(pred.map((item) => item.toLowerCase().replace(/\s/g, '').trim()).filter(Boolean));
  if (g.size === 0) return 1;
  if (p.size === 0) return 0;
  let hit = 0;
  for (const item of g) {
    if (p.has(item)) {
      hit += 1;
      continue;
    }
    // 允许包含关系（"Java" vs "Java 开发"）算命中
    for (const candidate of p) {
      if (candidate.includes(item) || item.includes(candidate)) {
        hit += 1;
        break;
      }
    }
  }
  if (hit === 0) return 0;
  const precision = hit / Math.max(g.size, p.size);
  const recall = hit / g.size;
  return (2 * precision * recall) / (precision + recall);
}

function deadlineMatch(gold: GoldLikely, pred: PredLike): FieldScore {
  // kind 永远参与评分（absent 也是有效答案）
  if (gold.deadline_kind !== pred.deadline_kind) return 0;
  if (gold.deadline_kind !== 'provided') return 1;
  if (gold.deadline_at === null) return null;
  if (pred.deadline_at === null) return 0;
  return gold.deadline_at.slice(0, 10) === pred.deadline_at.slice(0, 10) ? 1 : 0;
}

function salaryMatch(gold: GoldLikely, pred: PredLike): FieldScore {
  if (gold.salary_min === null && gold.salary_max === null) return null;
  const near = (a: number | null, b: number | null): boolean => {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return Math.abs(a - b) <= 1; // 允许 1K 的解析误差
  };
  return near(gold.salary_min, pred.salary_min) && near(gold.salary_max, pred.salary_max) ? 1 : 0;
}

export function scoreItem(gold: GoldLikely, pred: PredLike): ItemScore {
  const perField: Record<FieldId, FieldScore> = {
    company: textMatch(gold.company, pred.company),
    title: titleMatch(gold.title, pred.title),
    cities: gold.cities.length === 0 ? null : setF1(gold.cities, pred.cities),
    deadline: deadlineMatch(gold, pred),
    salary: salaryMatch(gold, pred),
    skills: gold.skills.length === 0 ? null : setF1(gold.skills, pred.skills),
  };

  const applicable = Object.values(perField).filter((value): value is number => value !== null);
  const macro = applicable.length === 0 ? 0 : applicable.reduce((sum, value) => sum + value, 0) / applicable.length;
  return { perField, macro };
}

export interface Aggregate {
  macro: number;
  items: number;
  perField: Record<FieldId, { score: number; evaluated: number; perfect: number }>;
}

export function aggregate(scores: readonly ItemScore[]): Aggregate {
  const fields: FieldId[] = ['company', 'title', 'cities', 'deadline', 'salary', 'skills'];
  const perField = Object.fromEntries(
    fields.map((field) => [field, { score: 0, evaluated: 0, perfect: 0 }]),
  ) as Aggregate['perField'];

  for (const item of scores) {
    for (const field of fields) {
      const value = item.perField[field];
      if (value === null) continue;
      perField[field].score += value;
      perField[field].evaluated += 1;
      if (value >= 0.999) perField[field].perfect += 1;
    }
  }
  for (const field of fields) {
    const bucket = perField[field];
    bucket.score = bucket.evaluated === 0 ? 0 : bucket.score / bucket.evaluated;
  }
  const macro = scores.length === 0 ? 0 : scores.reduce((sum, item) => sum + item.macro, 0) / scores.length;
  return { macro, items: scores.length, perField };
}
