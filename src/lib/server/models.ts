/**
 * 模型路由器（F-07 生效点）
 *
 * 优先级：**DB 里保存的凭证（设置页）> .env**。
 * DB 不可用或没有凭证时自动回退 .env，保证"设置页没配也能跑"。
 */

import { createCredentialStore, applyCredentialOverrides } from '../credentials/store.ts';
import { createModelRouter, type ModelRouter } from '../llm/profiles.ts';
import { resolveTenant } from '../tenant.ts';

import { getEnv } from './env.ts';

/** 构造 router；DB 凭证覆盖 env。失败一律回退 env，不阻塞请求。 */
export async function getModelRouter(): Promise<ModelRouter> {
  const env = getEnv();
  try {
    const tenant = resolveTenant(env);
    const store = await createCredentialStore(env.databaseUrl);
    const secrets = await store.loadSecrets(tenant.userId);
    if (secrets.length > 0) return createModelRouter(applyCredentialOverrides(env, secrets), {});
  } catch {
    /* 数据库不可用 / 解密失败 → 回退 .env */
  }
  return createModelRouter(env, {});
}
