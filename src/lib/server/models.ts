/**
 * 模型路由器（F-07 生效点）
 *
 * 优先级：**DB 里保存的凭证（设置页）> .env**。
 * DB 不可用或没有凭证时自动回退 .env，保证"设置页没配也能跑"。
 *
 * F-09 T8：这里注入 `onUsage`，把所有真实模型调用写进 `llm_usage_logs`（best-effort，失败不影响业务）。
 */

import { createCredentialStore, applyCredentialOverrides } from '../credentials/store.ts';
import { createModelRouter, type ModelRouter } from '../llm/profiles.ts';
import type { UsageRecord } from '../llm/types.ts';
import { resolveTenant } from '../tenant.ts';

import { getEnv } from './env.ts';
import { recordUsage } from './usage.ts';

/** 构造 router；DB 凭证覆盖 env。失败一律回退 env，不阻塞请求。 */
export async function getModelRouter(): Promise<ModelRouter> {
  const env = getEnv();
  const userId = resolveTenant(env).userId;
  // 用量记账：不 await、不抛错（日志不能拖垮业务）
  const onUsage = (record: UsageRecord) => {
    void recordUsage(userId, record);
  };

  try {
    const tenant = resolveTenant(env);
    const store = await createCredentialStore(env.databaseUrl);
    const secrets = await store.loadSecrets(tenant.userId);
    if (secrets.length > 0) return createModelRouter(applyCredentialOverrides(env, secrets), { onUsage });
  } catch {
    /* 数据库不可用 / 解密失败 → 回退 .env */
  }
  return createModelRouter(env, { onUsage });
}
