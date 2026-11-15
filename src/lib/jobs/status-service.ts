/**
 * 投递状态服务（F-08 / I3 T3）
 *
 * 职责：把"判定 → 校验备注 → 原子写入"固化成**一个用例**，供 API / 看板 / CLI 共用。
 * 判定逻辑本身在 `src/lib/status.ts`（纯函数、可穷举测试），这里只做编排与错误映射。
 *
 * 三个关键约束：
 *   1. 状态更新与事件写入**同一事务**（仓储层保证）；
 *   2. 乐观并发：调用方可传 `from`，不一致返回 CONFLICT（看板刷新提示）；
 *   3. 非法流转/缺备注**不抛异常**，返回带中文原因的结构化结果（UI 直接渲染）。
 */

import type { JobEventRecord, JobRecord, JobRepository } from '../db/types.ts';
import {
  decideTransition,
  describeTransition,
  isJobStatus,
  validateNote,
  type JobStatus,
  type TransitionKind,
} from '../status.ts';

export type TransitionErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'ILLEGAL_TRANSITION' | 'NOTE_REQUIRED';

export type TransitionOutcome =
  | {
      ok: true;
      status: 'updated' | 'unchanged';
      job: JobRecord;
      from: JobStatus;
      to: JobStatus;
      kind: TransitionKind;
      event?: JobEventRecord;
      message: string;
    }
  | {
      ok: false;
      code: TransitionErrorCode;
      message: string;
      hint?: string;
      currentStatus?: string;
      job?: JobRecord;
    };

export interface TransitionParams {
  userId: string;
  jobId: string;
  to: string;
  note?: string | null;
  /** 乐观并发：调用方看到的当前状态；不一致即冲突 */
  from?: string | null;
}

export async function transitionJobStatus(
  repo: JobRepository,
  params: TransitionParams,
): Promise<TransitionOutcome> {
  if (!isJobStatus(params.to)) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `未知状态：「${String(params.to)}」`,
      hint: '状态必须是 13 个枚举值之一（见 src/lib/status.ts）',
    };
  }
  const to: JobStatus = params.to;

  const job = await repo.findById(params.userId, params.jobId);
  if (!job) {
    return { ok: false, code: 'NOT_FOUND', message: '岗位不存在或已删除' };
  }
  if (!isJobStatus(job.status)) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `岗位当前状态「${job.status}」不在 13 个枚举内`,
      hint: '数据可能是旧版本写入的；可先在工作区台账或数据库把状态改为合法值',
      currentStatus: job.status,
    };
  }
  const from: JobStatus = job.status;

  // 乐观并发：调用方看到的与库内不一致 → 冲突（不写库）
  if (params.from !== undefined && params.from !== null && params.from !== from) {
    return {
      ok: false,
      code: 'CONFLICT',
      message: `岗位状态已被修改（当前为「${from}」）`,
      hint: '刷新看板后重试',
      currentStatus: from,
    };
  }

  const decision = decideTransition(from, to);
  if (!decision.allowed) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: decision.reason ?? '不允许的状态流转',
      currentStatus: from,
    };
  }

  // 幂等：同状态不写事件
  if (decision.unchanged) {
    return {
      ok: true,
      status: 'unchanged',
      job,
      from,
      to,
      kind: decision.kind,
      message: `状态已经是「${to}」，无需变更`,
    };
  }

  const noteError = validateNote(params.note, decision);
  if (noteError) {
    return { ok: false, code: 'NOTE_REQUIRED', message: noteError, currentStatus: from };
  }

  const written = await repo.updateStatus(params.userId, params.jobId, to, {
    note: (params.note ?? '').trim().length > 0 ? (params.note ?? '').trim() : null,
    isRollback: decision.kind === 'rollback',
    isReactivation: decision.kind === 'reactivation',
    expectedFrom: from,
  });

  if (!written.ok) {
    if (written.code === 'CONFLICT') {
      return {
        ok: false,
        code: 'CONFLICT',
        message: `岗位状态已被修改（当前为「${written.currentStatus ?? '未知'}」）`,
        hint: '刷新看板后重试',
        ...(written.currentStatus ? { currentStatus: written.currentStatus } : {}),
      };
    }
    return { ok: false, code: 'NOT_FOUND', message: '岗位不存在或已删除' };
  }

  return {
    ok: true,
    status: 'updated',
    job: written.job,
    event: written.event,
    from,
    to,
    kind: decision.kind,
    message: describeTransition(from, to),
  };
}

export interface TimelineResult {
  job: JobRecord;
  events: JobEventRecord[];
}

/** 某岗位的流转时间线（倒序，最近的在前） */
export async function listJobTimeline(
  repo: JobRepository,
  params: { userId: string; jobId: string; limit?: number },
): Promise<TimelineResult | null> {
  const job = await repo.findById(params.userId, params.jobId);
  if (!job) return null;
  const events = await repo.listEvents(params.userId, params.jobId, params.limit ?? 50);
  return { job, events };
}
