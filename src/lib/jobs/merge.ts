/**
 * 重复 JD 合并（F-08 / I3 T8 支撑 API 与逻辑）
 *
 * 与 `saveJob` 的 duplicate 分支配合：用户在确认页看到"该岗位已存在"后可选「合并到已有」。
 * 合并口径：保留旧记录 id；新 JD 里**旧值为空的字段**补齐；原文**追加**（保留两份，分隔符）。
 */

import type { JobRecord, JobRepository } from '../db/types.ts';
import { toJobDraft } from '../jobs/mapping.ts';
import { validateExtraction } from '../pipeline/validate.ts';
import type { JdExtraction } from '../schemas/jd.ts';

export type MergeStatus = 'merged' | 'no_change' | 'invalid' | 'not_found';

export interface MergeResult {
  status: MergeStatus;
  job?: JobRecord;
  /** 补齐了哪些字段（给 UI 提示"合并了什么"） */
  filled: string[];
  messages: string[];
}

const SEPARATOR = '\n\n---\n\n【另一份重复 JD 原文】\n\n';

export async function mergeDuplicateJob(
  repo: JobRepository,
  params: { userId: string; jobId: string; extraction: JdExtraction },
): Promise<MergeResult> {
  const existing = await repo.findById(params.userId, params.jobId);
  if (!existing) return { status: 'not_found', filled: [], messages: ['要合并的岗位不存在或已删除'] };

  const validation = validateExtraction(params.extraction, {});
  if (!validation.ok) {
    return { status: 'invalid', filled: [], messages: ['新 JD 校验未通过，无法合并'] };
  }
  const draft = toJobDraft(params.extraction, validation, {});

  const filled: string[] = [];
  const patch: Parameters<JobRepository['update']>[2] = {};

  // 1) 旧值为空的字段用新值补齐（不覆盖用户已有内容）
  if (existing.company.trim().length === 0 && draft.company.trim().length > 0) {
    patch.company = draft.company;
    filled.push('公司');
  }
  if (existing.title.trim().length === 0 && draft.title.trim().length > 0) {
    patch.title = draft.title;
    filled.push('岗位');
  }
  const citySet = new Set([...existing.cities, ...draft.cities]);
  if (citySet.size > existing.cities.length && existing.cities.length === 0) {
    patch.cities = [...citySet];
    filled.push('城市');
  }
  if (existing.salary_min === null && draft.salary_min !== null) {
    patch.salary_min = draft.salary_min;
    filled.push('薪资下限');
  }
  if (existing.salary_max === null && draft.salary_max !== null) {
    patch.salary_max = draft.salary_max;
    filled.push('薪资上限');
  }
  if (existing.deadline_kind === 'absent' && draft.deadline_kind !== 'absent') {
    patch.deadline_kind = draft.deadline_kind;
    patch.deadline = draft.deadline;
    patch.deadline_text = draft.deadline_text;
    filled.push('截止日期');
  }

  // 2) 原文追加（两份都留着，便于以后核对）
  const appended = `${existing.raw_text}${SEPARATOR}${draft.raw_text}`;
  const nextRawText = appended.length > 20000 ? appended.slice(-20000) : appended;

  const updated = await repo.update(params.userId, params.jobId, {
    ...patch,
    raw_text: nextRawText,
  });
  if (!updated) return { status: 'not_found', filled: [], messages: ['合并时岗位已被删除'] };

  // 3) 事件留痕（状态不变，但记录"合并重复 JD"）
  await repo.updateStatus(params.userId, params.jobId, updated.status, {
    note: `合并重复 JD${filled.length > 0 ? `（补齐：${filled.join('、')}）` : ''}`,
    isRollback: false,
    isReactivation: false,
  });

  return {
    status: filled.length > 0 ? 'merged' : 'no_change',
    job: updated,
    filled,
    messages: [filled.length > 0 ? `已合并，补齐：${filled.join('、')}` : '已合并（没有需要补齐的字段）'],
  };
}
