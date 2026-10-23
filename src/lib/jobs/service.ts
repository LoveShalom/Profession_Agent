/**
 * 岗位入库服务（F-02 / T9 服务层）
 *
 * 职责：把"校验 → 查重 → 落库"这三步固化成一个可测试的用例，
 * 让 API 路由、CLI、将来的 MCP Server 共用同一套逻辑（不是三套）。
 *
 * 三个关键决策：
 *   1. **有 blocker 不落库**：返回 `blocked` 而不是抛异常——UI 需要拿到具体原因渲染表单；
 *   2. **指纹重复返回 `duplicate`**：不静默覆盖、也不静默新建，把三个选项（查看已有 / 强制新建 / 取消）
 *      交给调用方（AC-5）；
 *   3. **强制新建也走同一入口**（`forceCreate: true`），保证技能属性一起写入。
 */

import type { JobRepository } from '../db/types.ts';
import type { FieldId } from '../schemas/field-dict.ts';
import { describeBlockers, validateExtraction, type ValidationBlocker, type ValidateResult } from '../pipeline/validate.ts';
import type { JdExtraction } from '../schemas/jd.ts';

import { toJobDraft, toJobSkillRows, type JobDraft } from './mapping.ts';

export type SaveJobStatus = 'created' | 'duplicate' | 'blocked';

export interface SaveJobParams {
  userId: string;
  extraction: JdExtraction;
  /** 可复用外部已算好的校验结果；不传则内部重新校验 */
  validation?: ValidateResult;
  /** 指纹命中时仍要新建（用户在重复提示里选择"强制新建"） */
  forceCreate?: boolean;
  /** 用户在确认页已人工核对/修改的字段（豁免"有值必须有证据"的阻塞） */
  confirmedFields?: readonly FieldId[];
}

export interface SaveJobResult {
  status: SaveJobStatus;
  /** blocked 时为 undefined */
  job?: {
    id: string;
    fingerprint: string;
    company: string;
    title: string;
    status: string;
    review_flags: readonly string[];
  };
  /** duplicate 时给出已存在的岗位，供 UI 展示"查看已有 / 强制新建" */
  duplicateOf?: {
    id: string;
    fingerprint: string;
    company: string;
    title: string;
    createdAt: string;
  };
  blockers: ValidationBlocker[];
  /** blocker 的中文文案（UI 直接渲染） */
  messages: string[];
  draft?: JobDraft;
}

export async function saveJob(repo: JobRepository, params: SaveJobParams): Promise<SaveJobResult> {
  const validation =
    params.validation ??
    validateExtraction(
      params.extraction,
      params.confirmedFields && params.confirmedFields.length > 0 ? { confirmedFields: params.confirmedFields } : {},
    );
  const draft = toJobDraft(params.extraction, validation);

  // 1) 校验未通过：不落库，把原因带回去
  if (!validation.ok) {
    return {
      status: 'blocked',
      blockers: validation.blockers,
      messages: describeBlockers(validation.blockers),
      draft,
    };
  }

  // 2) 查重（G-06：同 user + 同指纹 = 同一岗位）
  const existing = await repo.findByFingerprint(params.userId, draft.fingerprint);
  if (existing && !params.forceCreate) {
    return {
      status: 'duplicate',
      duplicateOf: {
        id: existing.id,
        fingerprint: existing.fingerprint,
        company: existing.company,
        title: existing.title,
        createdAt: existing.createdAt,
      },
      blockers: [],
      messages: ['该岗位已存在（公司 + 岗位 + 城市一致）'],
      draft,
    };
  }

  // 3) 落库（岗位 + 技能属性）
  const record = await repo.insert(params.userId, draft, toJobSkillRows(params.extraction));

  return {
    status: 'created',
    job: {
      id: record.id,
      fingerprint: record.fingerprint,
      company: record.company,
      title: record.title,
      status: record.status,
      review_flags: record.review_flags,
    },
    blockers: [],
    messages: [],
    draft,
  };
}

export interface ListJobsResult {
  total: number;
  items: Array<{
    id: string;
    company: string;
    title: string;
    cities: string[];
    status: string;
    priority: string;
    deadlineKind: string;
    deadline: string | null;
    skills: string[];
    reviewFlags: string[];
    createdAt: string;
  }>;
}

/** 列表（F-02 的列表视图用；筛选/排序的完整版本在 I2 的 F2 任务里） */
export async function listJobs(
  repo: JobRepository,
  userId: string,
  options: { limit?: number; status?: string; onlyNeedsReview?: boolean } = {},
): Promise<ListJobsResult> {
  const [items, total] = await Promise.all([repo.list(userId, options), repo.count(userId)]);
  return {
    total,
    items: items.map((job) => ({
      id: job.id,
      company: job.company,
      title: job.title,
      cities: job.cities,
      status: job.status,
      priority: job.priority,
      deadlineKind: job.deadline_kind,
      deadline: job.deadline,
      skills: job.skills,
      reviewFlags: [...job.review_flags],
      createdAt: job.createdAt,
    })),
  };
}
