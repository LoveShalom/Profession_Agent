/**
 * 经历库仓储工厂（F-05）
 * 进程内单例：连接池复用，避免每次请求新建 Pool。
 */

import { getEnv } from '../server/env.ts';

import { createPostgresExperienceRepository, type ExperienceRepository } from './service.ts';

let cached: ExperienceRepository | null = null;

export async function getExperienceRepository(): Promise<ExperienceRepository> {
  if (cached) return cached;
  cached = await createPostgresExperienceRepository(getEnv().databaseUrl);
  return cached;
}

export function resetExperienceRepository(): void {
  cached = null;
}
