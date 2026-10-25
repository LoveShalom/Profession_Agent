/**
 * 仓储接口（F-02 / T9）
 *
 * 为什么先定接口而不是直接写 SQL：本地优先（C-10）意味着"用户可能只有 Postgres"、
 * 也可能先在无 DB 环境跑通闭环。接口把"业务逻辑"与"存储实现"隔开：
 *   · `memory.ts` —— 内存实现，跑单测 / 演示，零依赖；
 *   · `postgres.ts` —— 真实实现（需要 `pg` 依赖），本地栈用；
 *   · 将来若要支持 SQLite / 文件存储，只需再实现一次接口。
 *
 * 约定：所有方法都要求 `userId`（多账号模式下由会话给出；单用户模式用固定 ID）。
 */

import type { JobDraft, JobSkillRow } from '../jobs/mapping.ts';
import type { FieldId } from '../schemas/field-dict.ts';

/** 截止三态（与 JobDraft 的列类型保持一致，避免重复定义） */
export type DeadlineKind = JobDraft['deadline_kind'];

/**
 * 岗位记录：比入库草稿多出同步/流转字段。
 * `status` / `priority` 在这里放宽为 `string`——入库时默认 `saved`/`中`，
 * 但流转与台账同步会写入其它值（13 状态机在 I3 落地）。
 */
export interface JobRecord extends Omit<JobDraft, 'status' | 'priority'> {
  status: string;
  priority: string;
  id: string;
  userId: string;
  /** 台账同步的单调修订号（F-03） */
  revision: number;
  /** 用户备注（台账「备注」列） */
  notes: string;
  nextAction: string | null;
  nextActionAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 台账同步 / 用户编辑允许修改的字段（F-03 T2） */
export interface JobPatch {
  company?: string;
  title?: string;
  cities?: string[];
  job_type?: string;
  graduation_year?: number | null;
  education?: string;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_months?: number | null;
  salary_negotiable?: boolean;
  deadline?: string | null;
  deadline_kind?: DeadlineKind;
  deadline_text?: string | null;
  status?: string;
  priority?: string;
  nextAction?: string | null;
  nextActionAt?: string | null;
  notes?: string;
  /** 覆盖 `jobs.skills`（归一化技能名集合） */
  skills?: string[];
  /** 覆盖待确认字段（用户校准后应删除对应项） */
  review_flags?: FieldId[];
  /** 乐观并发：revision 不匹配时返回 null（冲突） */
  expectedRevision?: number;
}

export interface ListJobsOptions {
  limit?: number;
  status?: string;
  /** 只看有阻塞/待确认的岗位 */
  onlyNeedsReview?: boolean;
}

export interface JobRepository {
  /** 按指纹查重（G-06：(user_id, fingerprint) 唯一） */
  findByFingerprint(userId: string, fingerprint: string): Promise<JobRecord | null>;
  findById(userId: string, id: string): Promise<JobRecord | null>;
  /** 插入岗位 + 技能属性（应在同一事务内） */
  insert(userId: string, draft: JobDraft, skills: readonly JobSkillRow[]): Promise<JobRecord>;
  /** 部分更新；`expectedRevision` 不匹配时返回 null（F-03 双向同步） */
  update(userId: string, id: string, patch: JobPatch): Promise<JobRecord | null>;
  /** 用「人工校准后的明确技能」替换 explicit 行（inferred 保留） */
  replaceExplicitSkills(userId: string, jobId: string, skills: readonly JobSkillRow[]): Promise<void>;
  list(userId: string, options?: ListJobsOptions): Promise<JobRecord[]>;
  count(userId: string): Promise<number>;
  /** 取某岗位的技能属性（测试与详情页用） */
  listSkills(jobId: string): Promise<JobSkillRow[]>;
}
