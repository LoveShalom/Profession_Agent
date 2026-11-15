/**
 * LLM 用量记账（F-09 / I4 T8/T9）
 *
 * 设计约束：
 *   · **绝不阻塞业务**：记账失败只吞掉（调用方 `void` 掉），不能因为日志让抽取失败；
 *   · **不落密钥**：只记 provider/model/task/tokens/耗时/降级/prompt 版本，不记 prompt 内容与 Key；
 *   · prompt 版本用 `prompts/*.md` 内容哈希，改了 prompt 自动变版本（T9）。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { UsageRecord } from '../llm/types.ts';
import { getEnv } from './env.ts';

const PROMPT_FILES: Record<string, string> = {
  extract: 'prompts/extract-jd.md',
  ocr: 'prompts/ocr-image.md',
  experience: 'prompts/experience-star.md',
  consistency: 'prompts/extract-jd.md',
  classify: 'prompts/extract-jd.md',
};

const versionCache = new Map<string, string | null>();

/** prompt 版本：文件内容 sha256 前 8 位；读不到返回 null（不编造） */
export function promptVersionOf(task: string): string | null {
  if (versionCache.has(task)) return versionCache.get(task)!;
  const file = PROMPT_FILES[task] ?? null;
  let version: string | null = null;
  if (file !== null) {
    try {
      version = createHash('sha256').update(readFileSync(path.resolve(process.cwd(), file), 'utf8')).digest('hex').slice(0, 8);
    } catch {
      version = null;
    }
  }
  versionCache.set(task, version);
  return version;
}

export interface UsageSummary {
  total: number;
  degradedRate: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
  /** 当月估算成本（元）；无成本数据时为 null */
  monthCost: number | null;
}

let poolPromise: Promise<unknown> | null = null;

async function getPool(): Promise<{
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}> {
  if (poolPromise === null) {
    poolPromise = (async () => {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: getEnv().databaseUrl });
      return pool;
    })();
  }
  return (await poolPromise) as {
    query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
}

/** 记一次调用（best-effort：任何失败都吞掉） */
export async function recordUsage(userId: string, record: UsageRecord): Promise<void> {
  try {
    const pool = await getPool();
    await pool.query(
      `insert into llm_usage_logs
         (user_id, provider, model, task, prompt_tokens, completion_tokens, latency_ms, cache_hit, degraded, prompt_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        record.provider,
        record.model,
        record.task,
        record.promptTokens,
        record.completionTokens,
        record.latencyMs,
        record.cacheHit,
        record.degraded,
        promptVersionOf(record.task),
      ],
    );
  } catch {
    /* 记账失败不影响业务 */
  }
}

/** 最近 N 条调用（诊断页用；表不存在/连不上时返回空） */
export async function listRecentUsage(userId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  try {
    const pool = await getPool();
    const result = await pool.query(
      `select provider, model, task, prompt_tokens, completion_tokens, latency_ms, degraded, prompt_version, created_at
         from llm_usage_logs where user_id = $1 order by created_at desc limit $2`,
      [userId, Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows;
  } catch {
    return [];
  }
}

/** 汇总（最近 30 天） */
export async function usageSummary(userId: string): Promise<UsageSummary | null> {
  try {
    const pool = await getPool();
    const result = await pool.query(
      `select count(*)::int as total,
              coalesce(sum(case when degraded then 1 else 0 end), 0)::int as degraded,
              coalesce(sum(prompt_tokens), 0)::int as prompt_tokens,
              coalesce(sum(completion_tokens), 0)::int as completion_tokens,
              coalesce(avg(latency_ms), 0)::int as avg_latency,
              sum(cost_estimate) as month_cost
         from llm_usage_logs
        where user_id = $1 and created_at >= now() - interval '30 days'`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const total = Number(row['total'] ?? 0);
    return {
      total,
      degradedRate: total === 0 ? 0 : Number(row['degraded'] ?? 0) / total,
      promptTokens: Number(row['prompt_tokens'] ?? 0),
      completionTokens: Number(row['completion_tokens'] ?? 0),
      avgLatencyMs: Number(row['avg_latency'] ?? 0),
      monthCost: row['month_cost'] === null || row['month_cost'] === undefined ? null : Number(row['month_cost']),
    };
  } catch {
    return null;
  }
}
