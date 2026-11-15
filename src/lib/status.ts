/**
 * 投递状态机（F-08 / I3 T2）—— 唯一真源
 *
 * 为什么单独一个模块：状态枚举、中文文案、行序、流转规则现在散落在多个组件里
 * （`PasteForm`、`WorkspacePanel`、导出表），I2 已经因此出现过"文案与枚举不一致"的隐患。
 * 这里集中一份，UI/API/导出全部引用它。
 *
 * 规则来自 `tech_stack §3.5`（G-03 裁决）与 ADR-0005（自研纯函数，不引入 XState）：
 *   · 行序即先后：`saved` 最早、`expired` 最晚；
 *   · 允许按行序**任意跨步前进**；
 *   · 允许**回退**到更早的任意非终态（必须备注）；
 *   · 终态之间**互转拒绝**；终态可**重新激活**到任意非终态（必须备注）；
 *   · 进入终态也必须备注（复盘时要知道"为什么结束"）。
 */

export const JOB_STATUSES = [
  'saved',
  'to_apply',
  'applied',
  'assessment',
  'written_test',
  'test_done',
  'interviewing',
  'offer_pending',
  'offered',
  'accepted',
  'rejected_by_company',
  'withdrawn',
  'expired',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** 终态：不再向前流转，只能重新激活 */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
  'accepted',
  'rejected_by_company',
  'withdrawn',
  'expired',
];

/** 看板默认显示的列（非终态 9 列）；终态收进"已结束"折叠区 */
export const BOARD_COLUMNS: readonly JobStatus[] = JOB_STATUSES.filter(
  (status) => !TERMINAL_STATUSES.includes(status),
);

export const STATUS_LABELS: Record<JobStatus, string> = {
  saved: '收藏',
  to_apply: '待投递',
  applied: '已投递',
  assessment: '待测评',
  written_test: '待笔试',
  test_done: '已笔试',
  interviewing: '面试中',
  offer_pending: '待 Offer',
  offered: '已 Offer',
  accepted: '已接受',
  rejected_by_company: '被拒',
  withdrawn: '本人放弃',
  expired: '已过期',
};

/** 备注最短长度（回退/终态/重新激活时校验） */
export const MIN_NOTE_LENGTH = 2;

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export function statusIndex(status: JobStatus): number {
  return JOB_STATUSES.indexOf(status);
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function statusLabel(status: JobStatus): string {
  return STATUS_LABELS[status];
}

export type TransitionKind = 'same' | 'forward' | 'rollback' | 'reactivation' | 'terminal-to-terminal' | 'invalid';

export interface TransitionDecision {
  allowed: boolean;
  /** 同状态：幂等，不写事件 */
  unchanged: boolean;
  /** 是否必须填备注（回退 / 进入终态 / 重新激活） */
  requiresNote: boolean;
  kind: TransitionKind;
  /** 拒绝原因（allowed=false 时给出，可直接展示给用户） */
  reason?: string;
}

/**
 * 判定一次流转是否合法。纯函数：不读库、不写库，因此可以 13×13 穷举测试。
 */
export function decideTransition(from: JobStatus, to: JobStatus): TransitionDecision {
  if (!isJobStatus(from) || !isJobStatus(to)) {
    return { allowed: false, unchanged: false, requiresNote: false, kind: 'invalid', reason: '未知状态值' };
  }

  // 1) 同状态：幂等
  if (from === to) {
    return { allowed: true, unchanged: true, requiresNote: false, kind: 'same' };
  }

  const fromTerminal = isTerminal(from);
  const toTerminal = isTerminal(to);

  // 2) 终态 → 终态：拒绝（语义打架，例如"本人放弃"再变"被拒"）
  if (fromTerminal && toTerminal) {
    return {
      allowed: false,
      unchanged: false,
      requiresNote: false,
      kind: 'terminal-to-terminal',
      reason: `「${statusLabel(from)}」与「${statusLabel(to)}」都是结束状态，不能互相流转；如需修正请先重新激活`,
    };
  }

  // 3) 终态 → 非终态：重新激活（必须备注）
  if (fromTerminal) {
    return { allowed: true, unchanged: false, requiresNote: true, kind: 'reactivation' };
  }

  // 4) 非终态 → 更早的非终态：回退（必须备注）
  if (statusIndex(to) < statusIndex(from)) {
    return { allowed: true, unchanged: false, requiresNote: true, kind: 'rollback' };
  }

  // 5) 非终态 → 更晚（含跨步，含进入终态）：允许；进入终态必须备注
  return { allowed: true, unchanged: false, requiresNote: toTerminal, kind: 'forward' };
}

/** 备注校验（与 decideTransition 配合；返回 null 表示通过） */
export function validateNote(note: string | null | undefined, decision: TransitionDecision): string | null {
  if (!decision.requiresNote) return null;
  const trimmed = (note ?? '').trim();
  if (trimmed.length < MIN_NOTE_LENGTH) {
    const action =
      decision.kind === 'rollback'
        ? '回退'
        : decision.kind === 'reactivation'
          ? '重新激活'
          : '进入结束状态';
    return `${action}必须填写备注（至少 ${MIN_NOTE_LENGTH} 个字），便于以后复盘`;
  }
  return null;
}

/** 时间线/提示文案：`待投递 → 已投递` */
export function describeTransition(from: JobStatus, to: JobStatus): string {
  return `${statusLabel(from)} → ${statusLabel(to)}`;
}
