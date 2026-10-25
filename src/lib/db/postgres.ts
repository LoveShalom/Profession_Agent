/**
 * Postgres 仓储实现（F-02 / T9）
 *
 * 依赖说明：`pg` 是本项目唯一的运行时数据库依赖，已写入 `package.json`，
 * 并在 `next.config.mjs` 的 `serverExternalPackages` 里声明为外部包（不参与 webpack 打包）。
 *
 * 事务：`insert` 必须在同一事务里写 `jobs` + `job_skills`，
 * 否则会出现"岗位在、技能丢了"的半截数据。
 */

import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import type { JobDraft, JobSkillRow } from '../jobs/mapping.ts';

import type { JobRecord, JobPatch, JobRepository, ListJobsOptions } from './types.ts';

const JOB_COLUMNS = [
  'user_id',
  'company',
  'title',
  'job_type',
  'graduation_year',
  'city',
  'cities',
  'work_mode',
  'salary_min',
  'salary_max',
  'salary_months',
  'salary_negotiable',
  'education',
  'experience_years',
  'skills',
  'deadline',
  'deadline_kind',
  'deadline_text',
  'source',
  'source_url',
  'channel',
  'is_referral',
  'referral_code',
  'raw_text',
  'jd_structured',
  'review_flags',
  'fingerprint',
  'status',
  'priority',
] as const;

function draftValues(userId: string, draft: JobDraft): unknown[] {
  return [
    userId,
    draft.company,
    draft.title,
    draft.job_type,
    draft.graduation_year,
    draft.city,
    draft.cities,
    draft.work_mode,
    draft.salary_min,
    draft.salary_max,
    draft.salary_months,
    draft.salary_negotiable,
    draft.education,
    draft.experience_years === null ? null : JSON.stringify(draft.experience_years),
    draft.skills,
    draft.deadline,
    draft.deadline_kind,
    draft.deadline_text,
    draft.source,
    draft.source_url,
    draft.channel,
    draft.is_referral,
    draft.referral_code,
    draft.raw_text,
    JSON.stringify(draft.jd_structured),
    draft.review_flags,
    draft.fingerprint,
    draft.status,
    draft.priority,
  ];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function toRecord(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    company: String(row['company']),
    title: String(row['title']),
    job_type: String(row['job_type']),
    graduation_year: row['graduation_year'] === null ? null : Number(row['graduation_year']),
    city: row['city'] === null ? null : String(row['city']),
    cities: asStringArray(row['cities']),
    work_mode: String(row['work_mode']),
    salary_min: row['salary_min'] === null ? null : Number(row['salary_min']),
    salary_max: row['salary_max'] === null ? null : Number(row['salary_max']),
    salary_months: row['salary_months'] === null ? null : Number(row['salary_months']),
    salary_negotiable: Boolean(row['salary_negotiable']),
    education: String(row['education']),
    experience_years: (row['experience_years'] ?? null) as JobRecord['experience_years'],
    skills: asStringArray(row['skills']),
    deadline: row['deadline'] === null ? null : new Date(String(row['deadline'])).toISOString(),
    deadline_kind: String(row['deadline_kind']) as JobRecord['deadline_kind'],
    deadline_text: row['deadline_text'] === null ? null : String(row['deadline_text']),
    source: String(row['source']),
    source_url: row['source_url'] === null ? null : String(row['source_url']),
    channel: row['channel'] === null ? null : String(row['channel']),
    is_referral: Boolean(row['is_referral']),
    referral_code: row['referral_code'] === null ? null : String(row['referral_code']),
    raw_text: String(row['raw_text']),
    jd_structured: (row['jd_structured'] ?? {}) as Record<string, unknown>,
    review_flags: asStringArray(row['review_flags']) as JobRecord['review_flags'],
    fingerprint: String(row['fingerprint']),
    status: String(row['status']) as JobRecord['status'],
    priority: String(row['priority']) as JobRecord['priority'],
    revision: row['revision'] === null || row['revision'] === undefined ? 1 : Number(row['revision']),
    notes: row['notes'] === null || row['notes'] === undefined ? '' : String(row['notes']),
    nextAction: row['next_action'] === null || row['next_action'] === undefined ? null : String(row['next_action']),
    nextActionAt:
      row['next_action_at'] === null || row['next_action_at'] === undefined
        ? null
        : new Date(String(row['next_action_at'])).toISOString(),
    createdAt: new Date(String(row['created_at'])).toISOString(),
    updatedAt: new Date(String(row['updated_at'])).toISOString(),
  };
}

export async function createPostgresJobRepository(connectionString: string): Promise<JobRepository> {
  const pool = new Pool({ connectionString });

  return {
    async findByFingerprint(userId: string, fingerprint: string): Promise<JobRecord | null> {
      const result = await pool.query(
        'select * from jobs where user_id = $1 and fingerprint = $2 and deleted_at is null limit 1',
        [userId, fingerprint],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? toRecord(row) : null;
    },

    async findById(userId: string, id: string): Promise<JobRecord | null> {
      const result = await pool.query('select * from jobs where user_id = $1 and id = $2 and deleted_at is null limit 1', [
        userId,
        id,
      ]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? toRecord(row) : null;
    },

    /** 台账同步的部分更新。`expectedRevision` 不匹配 → 返回 null（交给上层按"用户优先"处理） */
    async update(userId: string, id: string, patch: JobPatch): Promise<JobRecord | null> {
      const columnOf: Record<string, string> = {
        company: 'company',
        title: 'title',
        cities: 'cities',
        job_type: 'job_type',
        graduation_year: 'graduation_year',
        education: 'education',
        salary_min: 'salary_min',
        salary_max: 'salary_max',
        salary_months: 'salary_months',
        salary_negotiable: 'salary_negotiable',
        deadline: 'deadline',
        deadline_kind: 'deadline_kind',
        deadline_text: 'deadline_text',
        status: 'status',
        priority: 'priority',
        nextAction: 'next_action',
        nextActionAt: 'next_action_at',
        notes: 'notes',
        skills: 'skills',
        review_flags: 'review_flags',
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(columnOf)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
      // 改城市时同步首城列（jobs.city 是 cities[0] 的冗余列，列表/筛选依赖它）
      if (Array.isArray(patch.cities)) {
        values.push(patch.cities[0] ?? null);
        sets.push(`city = $${values.length}`);
      }
      if (sets.length === 0) {
        // 没有任何可改字段：回读原行（避免 `this` 在对象字面量里的类型歧义）
        const existing = await pool.query(
          'select * from jobs where user_id = $1 and id = $2 and deleted_at is null limit 1',
          [userId, id],
        );
        const row = existing.rows[0] as Record<string, unknown> | undefined;
        return row ? toRecord(row) : null;
      }

      values.push(userId, id);
      let sql = `update jobs set ${sets.join(', ')}, revision = revision + 1, updated_at = now() where user_id = $${values.length - 1} and id = $${values.length} and deleted_at is null`;
      if (patch.expectedRevision !== undefined) {
        values.push(patch.expectedRevision);
        sql += ` and revision = $${values.length}`;
      }
      const result = await pool.query(`${sql} returning *`, values);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? toRecord(row) : null;
    },

    /** 用人工校准后的明确技能替换 explicit 行；inferred 保留（F-03 主表技能列） */
    async replaceExplicitSkills(userId: string, jobId: string, skills: readonly JobSkillRow[]): Promise<void> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('begin');
        await client.query("delete from job_skills where user_id = $1 and job_id = $2 and source = 'explicit'", [
          userId,
          jobId,
        ]);
        for (const skill of skills) {
          await client.query(
            `insert into job_skills (user_id, job_id, skill, source, requirement, proficiency, confidence, basis_phrase, rule_id)
             values ($1, $2, $3, 'explicit', $4, $5, $6, $7, $8)
             on conflict (job_id, skill, source) do nothing`,
            [userId, jobId, skill.skill, skill.requirement, skill.proficiency, skill.confidence, skill.basisPhrase, skill.ruleId],
          );
        }
        await client.query(
          `update jobs set skills = (
             select coalesce(array_agg(distinct js.skill), '{}'::text[]) from job_skills js where js.job_id = $1
           ), revision = revision + 1, updated_at = now() where user_id = $2 and id = $1`,
          [jobId, userId],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async insert(userId: string, draft: JobDraft, skills: readonly JobSkillRow[]): Promise<JobRecord> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('begin');
        const placeholders = JOB_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
        const inserted = await client.query(
          `insert into jobs (${JOB_COLUMNS.join(', ')}) values (${placeholders}) returning *`,
          draftValues(userId, draft),
        );
        const record = toRecord(inserted.rows[0] as Record<string, unknown>);

        for (const skill of skills) {
          await client.query(
            `insert into job_skills (user_id, job_id, skill, source, requirement, proficiency, confidence, basis_phrase, rule_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (job_id, skill, source) do nothing`,
            [
              userId,
              record.id,
              skill.skill,
              skill.source,
              skill.requirement,
              skill.proficiency,
              skill.confidence,
              skill.basisPhrase,
              skill.ruleId,
            ],
          );
        }

        await client.query('commit');
        return record;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async list(userId: string, options: ListJobsOptions = {}): Promise<JobRecord[]> {
      const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
      const conditions = ['user_id = $1', 'deleted_at is null'];
      const values: unknown[] = [userId];
      if (options.status) {
        values.push(options.status);
        conditions.push(`status = $${values.length}`);
      }
      if (options.onlyNeedsReview) {
        conditions.push('cardinality(review_flags) > 0');
      }
      values.push(limit);
      const result = await pool.query(
        `select * from jobs where ${conditions.join(' and ')} order by created_at desc limit $${values.length}`,
        values,
      );
      return result.rows.map((row) => toRecord(row as Record<string, unknown>));
    },

    async count(userId: string): Promise<number> {
      const result = await pool.query(
        'select count(*)::int as total from jobs where user_id = $1 and deleted_at is null',
        [userId],
      );
      return Number((result.rows[0] as { total?: number } | undefined)?.total ?? 0);
    },

    async listSkills(jobId: string): Promise<JobSkillRow[]> {
      const result = await pool.query(
        `select skill, source, requirement, proficiency, confidence, basis_phrase, rule_id
           from job_skills where job_id = $1 order by source desc, confidence desc`,
        [jobId],
      );
      return result.rows.map((row) => {
        const record = row as Record<string, unknown>;
        return {
          skill: String(record['skill']),
          source: String(record['source']) as JobSkillRow['source'],
          requirement: String(record['requirement']) as JobSkillRow['requirement'],
          proficiency: String(record['proficiency']) as JobSkillRow['proficiency'],
          confidence: Number(record['confidence']),
          basisPhrase: String(record['basis_phrase']),
          ruleId: record['rule_id'] === null ? null : String(record['rule_id']),
        };
      });
    },
  };
}
