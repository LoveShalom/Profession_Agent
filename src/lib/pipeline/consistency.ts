/**
 * K=3 自一致性置信度（F-02 / T6，对应 A15 裁决）
 *
 * 动机：LLM 自报的 confidence 没有校准（它说 0.9 可能实际只有 0.6）。
 * A15 的做法是**同一份输入采样 K 次**，用"字段级一致率"替代自报置信度：
 *   3 次都抽出 "某科技有限公司" → confidence 1.0
 *   2 次抽 A、1 次抽 B          → confidence 0.67（0.67 < 0.7 → 自动进待确认）
 *
 * 这也天然给出"分层置信度"评测所需的信号：高置信字段的准确率应显著高于低置信字段。
 *
 * 归一化比对口径（G-02）：文本去空白/全半角/大小写；数组排序后比较；
 * 对象按键排序后的字符串比较。否则"上海、北京"与"北京、上海"会被判成不一致。
 */

import { isFieldId, FIELD_IDS, type FieldId } from '../schemas/field-dict.ts';
import { JdExtractionSchema, type JdExtraction } from '../schemas/jd.ts';

import { normalizeText } from './clean.ts';

export const DEFAULT_SAMPLE_K = 3;
export const MAX_SAMPLE_K = 5;

/** 归一化后用于比较的字符串（不用于展示） */
export function normalizeForCompare(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return normalizeText(value).toLowerCase().replace(/\s+/g, '');
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return value
      .map(normalizeForCompare)
      .filter((item) => item.length > 0)
      .sort()
      .join(',');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => `${key}=${normalizeForCompare(record[key])}`)
      .join(';');
  }
  return String(value);
}

export function fieldValuesEqual(a: unknown, b: unknown): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

export interface FieldAgreement {
  /** 众数出现次数 / 样本数 */
  agreement: number;
  /** 众数对应的原始值（取第一个出现该值的样本） */
  value: unknown;
  /** 该字段在所有样本中的原始值（便于排查） */
  samples: unknown[];
}

export interface ConsistencyResult {
  extraction: JdExtraction;
  /** 字段级一致率；未出现的字段没有条目 */
  agreement: Partial<Record<FieldId, number>>;
  /** 全部字段一致率的平均值（无字段时 0） */
  score: number;
  sampleCount: number;
}

/**
 * 合并 K 个样本：字段级"多数票 + 一致率"。
 * 一致率会**覆盖** LLM 自报的 confidence（这正是 A15 的核心）。
 */
export function computeConsistency(samples: readonly JdExtraction[]): ConsistencyResult {
  if (samples.length === 0) throw new Error('computeConsistency 需要至少 1 个样本');
  const first = samples[0]!;

  const agreement: Partial<Record<FieldId, number>> = {};
  const fields = { ...first.fields } as Record<string, unknown>;

  for (const id of FIELD_IDS) {
    const values = samples.map((sample) => (sample.fields as Record<string, unknown>)[id]);
    const present = values.filter((value) => normalizeForCompare(value).length > 0);
    if (present.length === 0) continue;

    const buckets = new Map<string, { count: number; value: unknown }>();
    for (const value of present) {
      const key = normalizeForCompare(value);
      const bucket = buckets.get(key);
      if (bucket) bucket.count += 1;
      else buckets.set(key, { count: 1, value });
    }

    const modal = [...buckets.values()].sort((a, b) => b.count - a.count)[0]!;
    // 统一保留 3 位小数：与 confidence 完全一致，避免 0.6666… 与 0.667 两种表示引起下游困惑
    agreement[id] = Number((modal.count / samples.length).toFixed(3));
    fields[id] = modal.value;
  }

  // 一致率覆盖自报置信度
  const confidence: Partial<Record<FieldId, number>> = { ...first.confidence };
  for (const id of FIELD_IDS) {
    const value = agreement[id];
    if (value !== undefined) confidence[id] = Number(value.toFixed(3));
  }

  // 证据取第一个样本（证据只用于追溯，不做多数票）
  const evidence = { ...first.evidence };

  // K 次里任一次认为要复核的字段，都进待确认（保守）
  const reviewSet = new Set<FieldId>();
  for (const sample of samples) {
    for (const id of sample.needsReview) if (isFieldId(id)) reviewSet.add(id);
  }

  const agreementValues = Object.values(agreement) as number[];
  const score = agreementValues.length === 0 ? 0 : agreementValues.reduce((sum, value) => sum + value, 0) / agreementValues.length;

  return {
    extraction: JdExtractionSchema.parse({
      fields,
      evidence,
      confidence,
      needsReview: [...reviewSet],
    }),
    agreement,
    score: Number(score.toFixed(3)),
    sampleCount: samples.length,
  };
}

/** 把 K 夹到合法范围（1–5） */
export function clampSampleK(k: number | undefined): number {
  if (!Number.isFinite(k ?? NaN)) return DEFAULT_SAMPLE_K;
  return Math.min(MAX_SAMPLE_K, Math.max(1, Math.trunc(k as number)));
}
