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

export interface JobRecord extends JobDraft {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
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
  /** 插入岗位 + 技能属性（应在同一事务内） */
  insert(userId: string, draft: JobDraft, skills: readonly JobSkillRow[]): Promise<JobRecord>;
  list(userId: string, options?: ListJobsOptions): Promise<JobRecord[]>;
  count(userId: string): Promise<number>;
  /** 取某岗位的技能属性（测试与详情页用） */
  listSkills(jobId: string): Promise<JobSkillRow[]>;
}
