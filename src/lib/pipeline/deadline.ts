/**
 * 截止时间三态判定（F-02 / T18，对应 R-3 裁决）
 *
 * 为什么需要三态：很多 JD **根本不写截止日期**。原设计把 deadline 当"关键字段"，
 * "无 evidence → 强制确认 + 入库按钮禁用"，会把这类 JD 永久卡住。
 * 三态把"JD 没写"从"抽取失败"里拆出来：
 *
 *   provided  —— 有明确日期（必须带 evidence，缺失才强制确认）
 *   text_only —— 只有模糊表述（"长期有效"/"招满为止"），原文进 deadline_text
 *   absent    —— 完全没提（合法状态，不阻塞入库、不进 needsReview）
 *
 * 时区口径：仅日期时取当日 23:59:59+08:00（tech_stack §9.2.0）。
 */

import type { Deadline } from '../schemas/jd.ts';
import { ABSENT_DEADLINE } from '../schemas/jd.ts';

/** 无明确日期但给出了"截止"语义的表述 */
export const TEXT_ONLY_PATTERNS: readonly RegExp[] = [
  /长期有效/,
  /长期招聘/,
  /招满(?:为止|即止)/,
  /随时(?:到岗|入职|投递)/,
  /滚动招聘/,
  /不设(?:截止|期限)/,
  /不限(?:截止)?(?:日期|时间)/,
];

const MAX_EVIDENCE = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 无年份日期若已过去超过该天数，视为"明年的同一天"（校招场景常见） */
const ROLL_OVER_DAYS = 30;

export function toEndOfDayIso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const yy = String(year).padStart(4, '0');
  return `${yy}-${mm}-${dd}T23:59:59+08:00`;
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function clip(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_EVIDENCE ? `${trimmed.slice(0, MAX_EVIDENCE)}…` : trimmed;
}

export interface ParsedDeadline {
  deadline: Deadline;
  /** 支撑该判定的原文片段（provided/text_only 必须有；absent 为 null） */
  evidence: string | null;
}

/**
 * 从文本判定截止时间三态。
 * @param now 用于补全"无年份"的日期，并在跨年后回滚
 */
export function parseDeadline(text: string, now: Date = new Date()): ParsedDeadline {
  // 1) 明确日期：2026-11-20 / 2026/11/20 / 2026.11.20 / 2026年11月20日
  const fullDate = text.match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
  if (fullDate) {
    const year = Number(fullDate[1]);
    const month = Number(fullDate[2]);
    const day = Number(fullDate[3]);
    if (isValidYmd(year, month, day)) {
      return {
        deadline: { kind: 'provided', at: toEndOfDayIso(year, month, day), text: null },
        evidence: clip(fullDate[0]),
      };
    }
  }

  // 2) 无年份：11月20日 / 11/20（仅取"X月X日"，避免把薪资"15k-25k"误当日月）
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (isValidYmd(now.getFullYear(), month, day)) {
      let year = now.getFullYear();
      const candidate = new Date(Date.UTC(year, month - 1, day));
      const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      if (nowUtc - candidate.getTime() > ROLL_OVER_DAYS * DAY_MS) year += 1;
      return {
        deadline: { kind: 'provided', at: toEndOfDayIso(year, month, day), text: null },
        evidence: clip(monthDay[0]),
      };
    }
  }

  // 3) 模糊表述 → text_only（保留原文，便于 UI 显示"原文：招满为止"）
  for (const pattern of TEXT_ONLY_PATTERNS) {
    const hit = text.match(pattern);
    if (hit) {
      return {
        deadline: { kind: 'text_only', at: null, text: clip(hit[0]) },
        evidence: clip(hit[0]),
      };
    }
  }

  // 4) 完全没提 → absent（合法状态，不阻塞入库）
  return { deadline: { ...ABSENT_DEADLINE }, evidence: null };
}

/** 剩余天数（仅 provided 有值；向上取整，今天=0） */
export function daysUntil(deadline: Deadline, now: Date = new Date()): number | null {
  if (deadline.kind !== 'provided' || !deadline.at) return null;
  const target = new Date(deadline.at).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((target - today) / DAY_MS);
}

/** 表格展示用：`2026-11-20` / `招满为止` / `—` */
export function deadlineLabel(deadline: Deadline): string {
  if (deadline.kind === 'provided' && deadline.at) return deadline.at.slice(0, 10);
  if (deadline.kind === 'text_only') return deadline.text ?? '未注明';
  return '—';
}
