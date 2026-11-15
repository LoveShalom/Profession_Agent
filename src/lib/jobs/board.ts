/**
 * 看板纯逻辑（F-08 / I3 T5）—— 与 React 无关，便于单测
 *
 * 抽出来的原因：拖拽/键盘/倒计时都有分支（无截止、今天截止、已过期、终态不可移动……），
 * 放在组件里只能靠肉眼验收；抽成纯函数后可以穷举测试。
 */

import { BOARD_COLUMNS, TERMINAL_STATUSES, isJobStatus, type JobStatus } from '../status.ts';

export interface BoardJobLike {
  id: string;
  company: string;
  title: string;
  cities: string[];
  status: string;
  priority: string;
  /** 分类 code（可空） */
  category?: string | null;
  deadline: string | null;
  deadlineKind: string;
  createdAt: string;
}

export type CountdownTone = 'danger' | 'warn' | 'ok' | 'muted';

export interface Countdown {
  /** 展示文案：`T-3 天` / `今天截止` / `已过期 2 天` / `未提供` */
  label: string;
  tone: CountdownTone;
  /** 距离截止的天数（已过期为正数）；无日期为 null */
  days: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 截止倒计时（F9）：只用日期部分计算，避免时区把"今天截止"算成"昨天"。
 */
export function deadlineCountdown(job: Pick<BoardJobLike, 'deadline' | 'deadlineKind'>, now: Date = new Date()): Countdown {
  if (job.deadlineKind === 'text_only') return { label: '见原文', tone: 'muted', days: null };
  if (job.deadlineKind !== 'provided' || !job.deadline) return { label: '未提供', tone: 'muted', days: null };

  const deadlineDate = job.deadline.slice(0, 10);
  const todayDate = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // 按 Asia/Shanghai
  const diff = Math.round((Date.parse(`${deadlineDate}T00:00:00Z`) - Date.parse(`${todayDate}T00:00:00Z`)) / DAY_MS);

  if (diff < 0) return { label: `已过期 ${-diff} 天`, tone: 'muted', days: -diff };
  if (diff === 0) return { label: '今天截止', tone: 'danger', days: 0 };
  if (diff <= 3) return { label: `T-${diff} 天`, tone: 'danger', days: diff };
  if (diff <= 7) return { label: `T-${diff} 天`, tone: 'warn', days: diff };
  return { label: `T-${diff} 天`, tone: 'ok', days: diff };
}

/** 看板列顺序里的上一个/下一个状态（键盘 ←/→ 用）；终态返回 null（不在看板列内） */
export function neighborStatus(status: JobStatus, direction: 'left' | 'right'): JobStatus | null {
  if (TERMINAL_STATUSES.includes(status)) return null;
  const index = BOARD_COLUMNS.indexOf(status);
  if (index < 0) return null;
  const target = direction === 'left' ? index - 1 : index + 1;
  if (target < 0 || target >= BOARD_COLUMNS.length) return null;
  return BOARD_COLUMNS[target]!;
}

/** 把岗位按状态分组；未知状态放进 `unknown` 便于提示而非静默丢弃 */
export function groupJobs(jobs: BoardJobLike[]): {
  columns: Map<JobStatus, BoardJobLike[]>;
  terminal: BoardJobLike[];
  unknown: BoardJobLike[];
} {
  const columns = new Map<JobStatus, BoardJobLike[]>(BOARD_COLUMNS.map((status) => [status, []]));
  const terminal: BoardJobLike[] = [];
  const unknown: BoardJobLike[] = [];
  for (const job of jobs) {
    if (!isJobStatus(job.status)) {
      unknown.push(job);
      continue;
    }
    if (TERMINAL_STATUSES.includes(job.status)) {
      terminal.push(job);
      continue;
    }
    columns.get(job.status)!.push(job);
  }
  // 列内按截止升序（无截止置后），与 listJobs 的默认排序口径一致
  for (const list of columns.values()) {
    list.sort((a, b) => {
      if (a.deadline === null && b.deadline === null) return a.createdAt.localeCompare(b.createdAt);
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return a.deadline.localeCompare(b.deadline);
    });
  }
  return { columns, terminal, unknown };
}
