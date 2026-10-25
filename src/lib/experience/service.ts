/**
 * 经历库仓储与服务（F-05 T1/T4）
 *
 * 与岗位库同构：接口 + 内存实现（测试）+ Postgres 实现（生产），业务逻辑只写一份。
 * 软删除：`deleted_at` 非空即视为删除，列表默认过滤，可恢复（C-01 裁决：回收站后置）。
 */

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { experienceDedupeKey } from '../pipeline/experience.ts';
import type { ExperienceForm, ExperienceType } from '../schemas/experience.ts';

export interface ExperienceRecord extends ExperienceForm {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ExperienceRepository {
  insert(userId: string, form: ExperienceForm): Promise<ExperienceRecord>;
  update(userId: string, id: string, form: ExperienceForm): Promise<ExperienceRecord | null>;
  findById(userId: string, id: string): Promise<ExperienceRecord | null>;
  list(userId: string, options?: { includeDeleted?: boolean; type?: ExperienceType }): Promise<ExperienceRecord[]>;
  softDelete(userId: string, id: string): Promise<boolean>;
  restore(userId: string, id: string): Promise<boolean>;
}

// ---------------------------------------------------------------- 内存实现
export function createMemoryExperienceRepository(): ExperienceRepository & { state: ExperienceRecord[] } {
  const state: ExperienceRecord[] = [];
  const now = () => new Date().toISOString();

  return {
    state,
    async insert(userId, form) {
      const record: ExperienceRecord = { ...form, id: randomUUID(), userId, createdAt: now(), updatedAt: now(), deletedAt: null };
      state.push(record);
      return record;
    },
    async update(userId, id, form) {
      const index = state.findIndex((item) => item.userId === userId && item.id === id);
      if (index < 0) return null;
      state[index] = { ...state[index]!, ...form, updatedAt: now() };
      return state[index]!;
    },
    async findById(userId, id) {
      return state.find((item) => item.userId === userId && item.id === id) ?? null;
    },
    async list(userId, options = {}) {
      return state
        .filter((item) => item.userId === userId)
        .filter((item) => (options.includeDeleted ? true : item.deletedAt === null))
        .filter((item) => (options.type ? item.type === options.type : true))
        .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
    },
    async softDelete(userId, id) {
      const item = state.find((entry) => entry.userId === userId && entry.id === id);
      if (!item) return false;
      item.deletedAt = now();
      return true;
    },
    async restore(userId, id) {
      const item = state.find((entry) => entry.userId === userId && entry.id === id);
      if (!item) return false;
      item.deletedAt = null;
      return true;
    },
  };
}

// ---------------------------------------------------------------- Postgres 实现
function toRecord(row: Record<string, unknown>): ExperienceRecord {
  const star = {
    situation: String(row['star_situation'] ?? ''),
    task: String(row['star_task'] ?? ''),
    action: String(row['star_action'] ?? ''),
    result: String(row['star_result'] ?? ''),
  };
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    type: String(row['type']) as ExperienceType,
    org: String(row['org']),
    role: row['role'] === null ? null : String(row['role']),
    startDate: row['start_date'] === null ? null : String(row['start_date']).slice(0, 7),
    endDate: row['end_date'] === null ? null : String(row['end_date']).slice(0, 7),
    summary: String(row['summary'] ?? ''),
    star,
    skills: Array.isArray(row['skills']) ? (row['skills'] as string[]) : [],
    metrics: Array.isArray(row['metrics']) ? (row['metrics'] as ExperienceForm['metrics']) : [],
    evidenceUrls: Array.isArray(row['evidence_urls']) ? (row['evidence_urls'] as string[]) : [],
    rawText: String(row['raw_text'] ?? ''),
    createdAt: new Date(String(row['created_at'])).toISOString(),
    updatedAt: new Date(String(row['updated_at'])).toISOString(),
    deletedAt: row['deleted_at'] === null || row['deleted_at'] === undefined ? null : new Date(String(row['deleted_at'])).toISOString(),
  };
}

/**
 * Postgres 的 date 类型必须带日：'2023-09' 会报 invalid input syntax。
 * 契约里日期精度是"月"，所以写入时补 '-01'，读取时再截回 YYYY-MM（toRecord 已 slice(0,10) 后再取 7 位）。
 */
export function toDateColumn(month: string | null): string | null {
  if (month === null || month.trim().length === 0) return null;
  const trimmed = month.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return `${trimmed}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

function values(userId: string, form: ExperienceForm): unknown[] {
  return [
    userId,
    form.type,
    form.org,
    form.role,
    toDateColumn(form.startDate),
    toDateColumn(form.endDate),
    form.summary,
    form.star.situation,
    form.star.task,
    form.star.action,
    form.star.result,
    form.skills,
    JSON.stringify(form.metrics),
    form.evidenceUrls,
    form.rawText,
  ];
}

const COLUMNS = [
  'user_id',
  'type',
  'org',
  'role',
  'start_date',
  'end_date',
  'summary',
  'star_situation',
  'star_task',
  'star_action',
  'star_result',
  'skills',
  'metrics',
  'evidence_urls',
  'raw_text',
] as const;

export async function createPostgresExperienceRepository(connectionString: string): Promise<ExperienceRepository> {
  const pool = new Pool({ connectionString });
  const findById = async (userId: string, id: string) => {
    const result = await pool.query('select * from experiences where user_id = $1 and id = $2 limit 1', [userId, id]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  };

  return {
    async insert(userId, form) {
      const placeholders = COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
      const result = await pool.query(
        `insert into experiences (${COLUMNS.join(', ')}) values (${placeholders}) returning *`,
        values(userId, form),
      );
      return toRecord(result.rows[0] as Record<string, unknown>);
    },
    async update(userId, id, form) {
      const sets = COLUMNS.filter((column) => column !== 'user_id')
        .map((column, index) => `${column} = $${index + 1}`)
        .join(', ');
      const params = values(userId, form).slice(1);
      params.push(userId, id);
      const result = await pool.query(
        `update experiences set ${sets}, updated_at = now() where user_id = $${params.length - 1} and id = $${params.length} returning *`,
        params,
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? toRecord(row) : null;
    },
    findById,
    async list(userId, options = {}) {
      const conditions = ['user_id = $1'];
      const params: unknown[] = [userId];
      if (!options.includeDeleted) conditions.push('deleted_at is null');
      if (options.type) {
        params.push(options.type);
        conditions.push(`type = $${params.length}`);
      }
      const result = await pool.query(
        `select * from experiences where ${conditions.join(' and ')} order by start_date desc nulls last, created_at desc`,
        params,
      );
      return result.rows.map((row) => toRecord(row as Record<string, unknown>));
    },
    async softDelete(userId, id) {
      const result = await pool.query(
        'update experiences set deleted_at = now(), updated_at = now() where user_id = $1 and id = $2 and deleted_at is null',
        [userId, id],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async restore(userId, id) {
      const result = await pool.query(
        'update experiences set deleted_at = null, updated_at = now() where user_id = $1 and id = $2 and deleted_at is not null',
        [userId, id],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

// ---------------------------------------------------------------- 服务层
export type SaveExperienceStatus = 'created' | 'duplicate' | 'updated';

export interface SaveExperienceResult {
  status: SaveExperienceStatus;
  experience: ExperienceRecord;
  duplicateOf?: { id: string; org: string; role: string | null; startDate: string | null };
}

/** 保存经历：同「组织+角色+起始月」视为重复，除非 forceCreate */
export async function saveExperience(
  repo: ExperienceRepository,
  params: { userId: string; form: ExperienceForm; forceCreate?: boolean; id?: string },
): Promise<SaveExperienceResult> {
  if (params.id) {
    const updated = await repo.update(params.userId, params.id, params.form);
    if (!updated) throw new Error('经历不存在或不属于当前用户');
    return { status: 'updated', experience: updated };
  }

  const key = experienceDedupeKey(params.form);
  const existing = (await repo.list(params.userId)).find(
    (item) => experienceDedupeKey(item) === key && item.deletedAt === null,
  );
  if (existing && params.forceCreate !== true) {
    return { status: 'duplicate', experience: existing, duplicateOf: { id: existing.id, org: existing.org, role: existing.role, startDate: existing.startDate } };
  }
  const created = await repo.insert(params.userId, params.form);
  return { status: 'created', experience: created };
}

/** 列表摘要（UI 用） */
export async function listExperiences(
  repo: ExperienceRepository,
  userId: string,
  options: { includeDeleted?: boolean; type?: ExperienceType } = {},
): Promise<{ total: number; resumeReady: number; items: Array<{ id: string; type: ExperienceType; org: string; role: string | null; startDate: string | null; resumeReady: boolean; skills: string[]; deletedAt: string | null }> }> {
  const items = await repo.list(userId, options);
  return {
    total: items.length,
    resumeReady: items.filter((item) => item.star.action.trim().length > 0 && item.star.result.trim().length > 0).length,
    items: items.map((item) => ({
      id: item.id,
      type: item.type,
      org: item.org,
      role: item.role,
      startDate: item.startDate,
      resumeReady: item.star.action.trim().length > 0 && item.star.result.trim().length > 0,
      skills: item.skills,
      deletedAt: item.deletedAt,
    })),
  };
}
