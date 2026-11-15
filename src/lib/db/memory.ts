/**
 * 内存仓储（F-02 / T9）
 *
 * 用途：单测、无数据库环境下的闭环演示、以及将来 E2E 的快速夹具。
 * **不是生产实现**——进程重启即丢数据；生产用 `postgres.ts`。
 */

import { randomUUID } from 'node:crypto';

import type { JobDraft, JobSkillRow } from '../jobs/mapping.ts';
import { effectiveTier } from '../jobs/category.ts';
import type {
  JobEventRecord,
  JobPatch,
  JobRecord,
  JobRepository,
  ListJobsOptions,
  StatusWriteResult,
} from './types.ts';

export interface MemoryRepositoryState {
  jobs: JobRecord[];
  skills: Map<string, JobSkillRow[]>;
  events: JobEventRecord[];
}

export function createMemoryJobRepository(): JobRepository & { state: MemoryRepositoryState } {
  const state: MemoryRepositoryState = { jobs: [], skills: new Map(), events: [] };

  return {
    state,

    async findByFingerprint(userId: string, fingerprint: string): Promise<JobRecord | null> {
      return state.jobs.find((job) => job.userId === userId && job.fingerprint === fingerprint) ?? null;
    },

    async findById(userId: string, id: string): Promise<JobRecord | null> {
      return state.jobs.find((job) => job.userId === userId && job.id === id) ?? null;
    },

    async insert(userId: string, draft: JobDraft, skills: readonly JobSkillRow[]): Promise<JobRecord> {
      const now = new Date().toISOString();
      const record: JobRecord = {
        ...draft,
        id: randomUUID(),
        userId,
        revision: 1,
        campaignTier: null,
        deletedAt: null,
        notes: '',
        nextAction: null,
        nextActionAt: null,
        createdAt: now,
        updatedAt: now,
      };
      state.jobs.push(record);
      state.skills.set(record.id, [...skills]);
      return record;
    },

    async update(userId: string, id: string, patch: JobPatch): Promise<JobRecord | null> {
      const index = state.jobs.findIndex((job) => job.userId === userId && job.id === id);
      if (index < 0) return null;
      const current = state.jobs[index]!;
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) return null;

      const { expectedRevision: _expected, ...fields } = patch;
      const updated: JobRecord = {
        ...current,
        ...fields,
        city: fields.cities ? (fields.cities[0] ?? null) : current.city,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      state.jobs[index] = updated;
      return updated;
    },

    async replaceExplicitSkills(userId: string, jobId: string, skills: readonly JobSkillRow[]): Promise<void> {
      const job = state.jobs.find((item) => item.userId === userId && item.id === jobId);
      if (!job) return;
      const existing = state.skills.get(jobId) ?? [];
      const inferred = existing.filter((row) => row.source !== 'explicit');
      state.skills.set(jobId, [...skills, ...inferred]);
      job.skills = [...new Set([...skills.map((row) => row.skill), ...inferred.map((row) => row.skill)])];
    },

    async list(userId: string, options: ListJobsOptions = {}): Promise<JobRecord[]> {
      let items = state.jobs.filter((job) => job.userId === userId);
      if (!options.includeDeleted) items = items.filter((job) => job.deletedAt === null);
      if (options.status) items = items.filter((job) => job.status === options.status);
      if (options.category) items = items.filter((job) => job.category === options.category);
      if (options.tier) {
        items = items.filter((job) => effectiveTier(job.category, job.campaignTier).tier === options.tier);
      }
      if (options.onlyNeedsReview) items = items.filter((job) => job.review_flags.length > 0);
      items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return options.limit ? items.slice(0, options.limit) : items;
    },

    async count(userId: string): Promise<number> {
      return state.jobs.filter((job) => job.userId === userId).length;
    },

    async softDelete(userId: string, jobId: string): Promise<boolean> {
      const job = state.jobs.find((item) => item.userId === userId && item.id === jobId);
      if (!job || job.deletedAt !== null) return false;
      job.deletedAt = new Date().toISOString();
      return true;
    },

    async restore(userId: string, jobId: string): Promise<boolean> {
      const job = state.jobs.find((item) => item.userId === userId && item.id === jobId);
      if (!job || job.deletedAt === null) return false;
      job.deletedAt = null;
      return true;
    },

    async listSkills(jobId: string): Promise<JobSkillRow[]> {
      return [...(state.skills.get(jobId) ?? [])];
    },

    async updateStatus(
      userId: string,
      jobId: string,
      to: string,
      meta: { note: string | null; isRollback: boolean; isReactivation: boolean; expectedFrom?: string },
    ): Promise<StatusWriteResult> {
      const index = state.jobs.findIndex((item) => item.userId === userId && item.id === jobId);
      if (index < 0) return { ok: false, code: 'NOT_FOUND' };
      const current = state.jobs[index]!;
      if (meta.expectedFrom !== undefined && current.status !== meta.expectedFrom) {
        return { ok: false, code: 'CONFLICT', currentStatus: current.status };
      }

      const now = new Date().toISOString();
      const updated: JobRecord = { ...current, status: to, revision: current.revision + 1, updatedAt: now };
      state.jobs[index] = updated;

      const event: JobEventRecord = {
        id: randomUUID(),
        userId,
        jobId,
        fromStatus: current.status,
        toStatus: to,
        note: meta.note,
        isRollback: meta.isRollback,
        isReactivation: meta.isReactivation,
        occurredAt: now,
      };
      state.events.push(event);
      return { ok: true, job: updated, event };
    },

    async listEvents(userId: string, jobId: string, limit = 50): Promise<JobEventRecord[]> {
      return state.events
        .filter((event) => event.userId === userId && event.jobId === jobId)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, limit);
    },
  };
}
