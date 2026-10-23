/**
 * 岗位指纹与去重（F-02 / T8，对应 G-06 裁决）
 *
 * G-06：**指纹 = 归一化公司 + 归一化岗位 + 排序后城市集合**；多城市视为不同记录；
 * 唯一约束落在 `(user_id, fingerprint)`（0001_init.sql 已建）。
 *
 * 归一化的目标不是"理解公司名"，而是让**同一条招聘信息的不同写法**落到同一个指纹上：
 *   "某科技有限公司" / "某科技" → 同一个
 *   "后端开发工程师（急招）" / "后端开发工程师" → 同一个
 *   "北京·上海" / "上海·北京" → 同一个（城市集合排序）
 *
 * 版本号参与哈希：将来调整归一化规则时必须升版本，否则历史指纹会与新算法不一致。
 */

import { createHash } from 'node:crypto';

import { CITY_ALIASES, normalizeText } from './clean.ts';

/** 归一化规则版本：改规则必须升版本（指纹会整体失效，需重建） */
export const FINGERPRINT_VERSION = 'fp-v1';

/**
 * 公司名只剥离**法人实体后缀**，不剥"科技/网络"这类名字成分——
 * 否则"某科技有限公司"与"某集团"都会被剥成"某"，造成误合并。
 */
const LEGAL_SUFFIXES: readonly string[] = [
  '股份有限公司',
  '有限责任公司',
  '有限公司',
  '集团有限公司',
  '集团',
  '控股',
  '研究院',
  '研究所',
  '银行',
  '证券',
  '保险',
];

/** 岗位名里的噪声：括号内容（急招/校招/总部…）、末尾的招聘词 */
const TITLE_BRACKETS = /[（(【\[][^）)】\]]*[）)】\]]/g;
const TITLE_TAILS: readonly string[] = ['急招', '急聘', '热招', '诚聘', '招聘中'];

export function normalizeCompanyForFingerprint(company: string): string {
  let text = normalizeText(company).toLowerCase().replace(/\s+/g, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (text.length > suffix.length && text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return text;
}

export function normalizeTitleForFingerprint(title: string): string {
  let text = normalizeText(title).toLowerCase().replace(/\s+/g, '');
  text = text.replace(TITLE_BRACKETS, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const tail of TITLE_TAILS) {
      if (text.length > tail.length && text.endsWith(tail)) {
        text = text.slice(0, -tail.length);
        changed = true;
      }
    }
  }
  return text.replace(/[-—_/·]+$/, '');
}

export function normalizeCityForFingerprint(city: string): string {
  const trimmed = normalizeText(city).replace(/\s+/g, '');
  return CITY_ALIASES[trimmed] ?? trimmed;
}

export interface FingerprintInput {
  company: string;
  title: string;
  cities: readonly string[];
}

/** 归一化后的三元组（可用于调试与日志——不含原始敏感信息） */
export function describeFingerprint(input: FingerprintInput): {
  company: string;
  title: string;
  cities: string[];
} {
  return {
    company: normalizeCompanyForFingerprint(input.company),
    title: normalizeTitleForFingerprint(input.title),
    cities: [...new Set(input.cities.map(normalizeCityForFingerprint).filter((city) => city.length > 0))].sort(),
  };
}

/** 计算岗位指纹（64 位十六进制） */
export function buildFingerprint(input: FingerprintInput): string {
  const normalized = describeFingerprint(input);
  const payload = [FINGERPRINT_VERSION, normalized.company, normalized.title, normalized.cities.join(',')].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** 两条 JD 是否指向同一个岗位 */
export function looksLikeSameJob(a: FingerprintInput, b: FingerprintInput): boolean {
  return buildFingerprint(a) === buildFingerprint(b);
}

/** 指纹短名（UI 展示/日志用，避免刷屏） */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 8);
}
