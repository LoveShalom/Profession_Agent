/**
 * 内存仓储（F-02 / T9）
 *
 * 用途：单测、无数据库环境下的闭环演示、以及将来 E2E 的快速夹具。
 * **不是生产实现**——进程重启即丢数据；生产用 `postgres.ts`。
 */

import { randomUUID } from 'node:crypto';

import type { JobDraft, JobSkillRow } from '../jobs/mapping.ts';
import type { JobPatch, JobRecord, JobRepository, ListJobsOptions } from './types.ts';

export interface MemoryRepositoryState {
  jobs: JobRecord[];
  skills: Map<string, JobSkillRow[]>;
}

export function createMemoryJobRepository(): JobRepository & { state: MemoryRepositoryState } {
  const state: MemoryRepositoryState = { jobs: [], skills: new Map() };

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
      if (options.status) items = items.filter((job) => job.status === options.status);
      if (options.onlyNeedsReview) items = items.filter((job) => job.review_flags.length > 0);
      items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return options.limit ? items.slice(0, options.limit) : items;
    },

    async count(userId: string): Promise<number> {
      return state.jobs.filter((job) => job.userId === userId).length;
    },

    async listSkills(jobId: string): Promise<JobSkillRow[]> {
      return [...(state.skills.get(jobId) ?? [])];
    },
  };
}
