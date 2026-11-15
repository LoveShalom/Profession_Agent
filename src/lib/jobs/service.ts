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

import type { JobPatch, JobRepository } from '../db/types.ts';
import type { FieldId } from '../schemas/field-dict.ts';
import { describeBlockers, validateExtraction, type ValidationBlocker, type ValidateResult } from '../pipeline/validate.ts';
import type { JdExtraction } from '../schemas/jd.ts';

import { effectiveTier } from './category.ts';
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
  /** 来源截图（相对工作区路径，写进 jd_structured.source_image） */
  sourceImage?: string;
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
  const draft = toJobDraft(params.extraction, validation, {
    ...(params.sourceImage ? { sourceImage: params.sourceImage } : {}),
  });

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
    /** 岗位分类 code（F-02 修订） */
    category: string | null;
    /** 有效投递定位（含手动覆盖） */
    tier: 'primary' | 'secondary' | 'casual';
    tierLabel: string;
    tierOverridden: boolean;
    /** 软删除时间（null = 未删除） */
    deletedAt: string | null;
    deadlineKind: string;
    deadline: string | null;
    skills: string[];
    reviewFlags: string[];
    createdAt: string;
  }>;
}

/** 列表（F-02 的列表视图用；筛选/排序的完整版本在 I2 的 F2 任务里） */
/** 允许通过 PATCH 修改的字段白名单（分类/优先级/备注/跟进时间；状态走专用接口） */
export type JobPatchParseResult =
  | { ok: true; patch: JobPatch }
  | { ok: false; message: string };

export function resolveJobPatch(input: Record<string, unknown>): JobPatchParseResult {
  const patch: JobPatch = {};

  if ('category' in input) {
    const value = input['category'];
    if (value !== null && typeof value !== 'string') return { ok: false, message: 'category 必须是字符串或 null' };
    const trimmed = typeof value === 'string' ? value.trim() : null;
    if (trimmed !== null && trimmed.length > 80) return { ok: false, message: 'category 最长 80 字符' };
    patch.category = trimmed === null || trimmed.length === 0 ? null : trimmed;
  }
  if ('priority' in input) {
    const value = input['priority'];
    if (value !== '高' && value !== '中' && value !== '低') return { ok: false, message: 'priority 只能是 高/中/低' };
    patch.priority = value;
  }
  if ('notes' in input) {
    const value = input['notes'];
    if (typeof value !== 'string') return { ok: false, message: 'notes 必须是字符串' };
    if (value.length > 4000) return { ok: false, message: 'notes 最长 4000 字' };
    patch.notes = value;
  }
  if ('nextActionAt' in input) {
    const value = input['nextActionAt'];
    if (value !== null && typeof value !== 'string') return { ok: false, message: 'nextActionAt 必须是 ISO 字符串或 null' };
    if (typeof value === 'string' && Number.isNaN(Date.parse(value))) return { ok: false, message: 'nextActionAt 不是合法时间' };
    patch.nextActionAt = value as string | null;
  }
  if ('campaignTier' in input) {
    const value = input['campaignTier'];
    if (value !== null && value !== 'primary' && value !== 'secondary' && value !== 'casual') {
      return { ok: false, message: 'campaignTier 只能是 primary/secondary/casual 或 null' };
    }
    patch.campaignTier = value as JobPatch['campaignTier'];
  }
  if ('nextAction' in input) {
    const value = input['nextAction'];
    if (value !== null && typeof value !== 'string') return { ok: false, message: 'nextAction 必须是字符串或 null' };
    patch.nextAction = (typeof value === 'string' ? value.trim() : null) || null;
  }
  return { ok: true, patch };
}

export type JobSortKey = 'updated' | 'deadline' | 'priority';

const PRIORITY_ORDER: Record<string, number> = { 高: 0, 中: 1, 低: 2 };

/** 排序：deadline 升序（无截止排最后）→ priority 高到低 → createdAt 倒序 */
function sortJobs<T extends { deadline: string | null; priority: string; createdAt: string }>(items: T[], sort: JobSortKey): T[] {
  const sorted = [...items];
  if (sort === 'priority') {
    sorted.sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
        b.createdAt.localeCompare(a.createdAt),
    );
    return sorted;
  }
  if (sort === 'updated') return sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // deadline（默认）：有截止的按时间升序在前，无截止的排最后
  sorted.sort((a, b) => {
    if (a.deadline === null && b.deadline === null) return b.createdAt.localeCompare(a.createdAt);
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline.localeCompare(b.deadline);
  });
  return sorted;
}

export async function listJobs(
  repo: JobRepository,
  userId: string,
  options: {
    limit?: number;
    status?: string;
    onlyNeedsReview?: boolean;
    sort?: JobSortKey;
    category?: string;
    includeDeleted?: boolean;
    tier?: 'primary' | 'secondary' | 'casual';
  } = {},
): Promise<ListJobsResult> {
  const [items, total] = await Promise.all([repo.list(userId, options), repo.count(userId)]);
  const sorted = sortJobs(items, options.sort ?? 'deadline');
  return {
    total,
    items: sorted.map((job) => ({
      id: job.id,
      company: job.company,
      title: job.title,
      cities: job.cities,
      status: job.status,
      priority: job.priority,
      category: job.category,
      ...(() => {
        const effective = effectiveTier(job.category, job.campaignTier);
        return { tier: effective.tier, tierLabel: effective.label, tierOverridden: effective.overridden };
      })(),
      deletedAt: job.deletedAt,
      deadlineKind: job.deadline_kind,
      deadline: job.deadline,
      skills: job.skills,
      reviewFlags: [...job.review_flags],
      createdAt: job.createdAt,
    })),
  };
}
