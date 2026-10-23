/**
 * 仓储工厂（F-02 / T9）
 *
 * 进程内单例：Next 的 route handler 每次请求都会执行模块代码，但连接池必须复用，
 * 否则每个请求都新建一个 pool，很快把连接数打满。
 */

import { getEnv } from '../server/env.ts';

import { createPostgresJobRepository } from './postgres.ts';
import type { JobRepository } from './types.ts';

let cached: JobRepository | null = null;

export async function getJobRepository(): Promise<JobRepository> {
  if (cached) return cached;
  cached = await createPostgresJobRepository(getEnv().databaseUrl);
  return cached;
}

/** 测试/热更新用 */
export function resetJobRepository(): void {
  cached = null;
}
