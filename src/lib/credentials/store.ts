/**
 * 模型凭证存储（F-07）
 *
 * 安全约定（tech_stack §5）：
 *   · API Key 用 **AES-256-GCM** 加密后存 `bytea`，主密钥只在 `.env`（不落库）；
 *   · 只写不回读：接口只返回 `keyLast4`，任何响应/日志都不出现明文；
 *   · 保存前必须 probe 通过，**坏凭证不入库**；
 *   · 主密钥非法时拒绝保存（绝不降级为明文）。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Pool } from 'pg';

import { ProviderError } from '../errors.ts';
import { createLLM } from '../llm/index.ts';
import { resolveProvider } from '../llm/registry.ts';
import type { Env } from '../env.ts';

export type CredentialRole = 'text' | 'vision';

export interface CredentialInput {
  role: CredentialRole;
  provider: string;
  baseUrl?: string;
  model?: string;
  apiKey: string;
}

export interface CredentialSummary {
  role: CredentialRole;
  provider: string;
  baseUrl: string;
  model: string;
  keyLast4: string;
  status: 'untested' | 'active' | 'invalid';
  lastVerifiedAt: string | null;
}

// ---------------------------------------------------------------- 加解密
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function keyBuffer(encryptionKey: string): Buffer {
  const key = Buffer.from(encryptionKey, 'base64');
  if (key.length !== 32) {
    throw ProviderError.config('ENCRYPTION_KEY 必须是 32 字节的 base64 字符串', '运行 npm run setup 重新生成');
  }
  return key;
}

export function encryptSecret(plain: string, encryptionKey: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(payload: Buffer, encryptionKey: string): string {
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', keyBuffer(encryptionKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** 仅保留尾号用于 UI 展示 */
export function maskKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  return trimmed.length <= 4 ? '••••' : trimmed.slice(-4);
}

// ---------------------------------------------------------------- 仓储
export async function createCredentialStore(connectionString: string) {
  const pool = new Pool({ connectionString });

  return {
    async upsert(userId: string, input: CredentialInput, encrypted: Buffer, status: 'active' | 'invalid'): Promise<void> {
      const resolved = resolveProvider({ provider: input.provider, baseUrl: input.baseUrl, model: input.model, allowPrivateBaseUrl: true });
      await pool.query(
        `insert into user_llm_credentials (user_id, provider, base_url, encrypted_api_key, key_last4, model_prefs, status, last_verified_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
         on conflict (user_id, provider, base_url) do update
           set encrypted_api_key = excluded.encrypted_api_key,
               key_last4 = excluded.key_last4,
               model_prefs = excluded.model_prefs,
               status = excluded.status,
               last_verified_at = now(),
               updated_at = now()`,
        [
          userId,
          resolved.preset.name,
          resolved.baseUrl,
          encrypted,
          maskKey(input.apiKey),
          JSON.stringify({ role: input.role, model: resolved.model }),
          status,
        ],
      );
    },

    async list(userId: string): Promise<CredentialSummary[]> {
      const result = await pool.query(
        `select provider, base_url, key_last4, model_prefs, status, last_verified_at
           from user_llm_credentials where user_id = $1 order by updated_at desc`,
        [userId],
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        const prefs = (row['model_prefs'] ?? {}) as { role?: CredentialRole; model?: string };
        return {
          role: prefs.role ?? 'text',
          provider: String(row['provider']),
          baseUrl: String(row['base_url']),
          model: prefs.model ?? '',
          keyLast4: String(row['key_last4'] ?? ''),
          status: String(row['status']) as CredentialSummary['status'],
          lastVerifiedAt: row['last_verified_at'] ? new Date(String(row['last_verified_at'])).toISOString() : null,
        };
      });
    },

    /** 读取可解密的凭证（仅服务端路由内部使用，绝不返回给客户端） */
    async loadSecrets(
      userId: string,
    ): Promise<Array<{ role: CredentialRole; provider: string; baseUrl: string; model: string; apiKey: string }>> {
      const result = await pool.query(
        `select provider, base_url, encrypted_api_key, model_prefs, status
           from user_llm_credentials where user_id = $1 and status = 'active'`,
        [userId],
      );
      return result.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        const prefs = (row['model_prefs'] ?? {}) as { role?: CredentialRole; model?: string };
        return {
          role: prefs.role ?? 'text',
          provider: String(row['provider']),
          baseUrl: String(row['base_url']),
          model: prefs.model ?? '',
          apiKey: row['encrypted_api_key'] ? decryptSecret(row['encrypted_api_key'] as Buffer, process.env['ENCRYPTION_KEY'] ?? '') : '',
        };
      });
    },

    async remove(userId: string, provider: string, baseUrl: string): Promise<boolean> {
      const result = await pool.query(
        'delete from user_llm_credentials where user_id = $1 and provider = $2 and base_url = $3',
        [userId, provider, baseUrl],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

// ---------------------------------------------------------------- 保存前 probe
export interface SaveCredentialResult {
  ok: boolean;
  error?: { code: string; message: string; hint?: string };
  summary?: CredentialSummary;
}

/** 保存凭证：先 probe 再落库（坏 Key 不写库） */
export async function saveCredential(params: {
  store: Awaited<ReturnType<typeof createCredentialStore>>;
  userId: string;
  env: Env;
  input: CredentialInput;
}): Promise<SaveCredentialResult> {
  const { input, env } = params;
  if (input.apiKey.trim().length === 0 && input.provider !== 'ollama') {
    return { ok: false, error: { code: 'E_KEY_MISSING', message: 'API Key 不能为空（Ollama 本地模型可留空）' } };
  }

  // 用候选配置构造一个临时 service 做真实探活
  const probeEnv: Env = {
    ...env,
    llmProvider: input.provider,
    llmBaseUrl: input.baseUrl,
    llmApiKey: input.apiKey,
    llmModel: input.model,
    llmModelExtract: undefined,
    llmModelGenerate: undefined,
  };

  let status: 'active' | 'invalid' = 'active';
  try {
    const service = createLLM(probeEnv, { skipProbe: true });
    const probe = await service.probe();
    if (!probe.ok) {
      status = 'invalid';
      return {
        ok: false,
        error: { code: 'E_PROBE_FAILED', message: `连通性验证失败：${probe.detail ?? '未知原因'}`, hint: '检查 Key、模型名与网络后重试' },
      };
    }
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : null;
    return {
      ok: false,
      error: {
        code: 'E_PROBE_FAILED',
        message: providerError?.message ?? (error instanceof Error ? error.message : String(error)),
        ...(providerError?.userHint ? { hint: providerError.userHint } : {}),
      },
    };
  }

  const encrypted = encryptSecret(input.apiKey, env.encryptionKey);
  await params.store.upsert(params.userId, input, encrypted, status);

  const summaries = await params.store.list(params.userId);
  const resolved = resolveProvider({ provider: input.provider, baseUrl: input.baseUrl, model: input.model, allowPrivateBaseUrl: true });
  const summary =
    summaries.find((item) => item.provider === resolved.preset.name && item.baseUrl === resolved.baseUrl) ?? undefined;
  return { ok: true, ...(summary ? { summary } : {}) };
}

/** 把 DB 凭证覆盖到 env（不修改 process.env，返回新对象） */
export function applyCredentialOverrides(
  env: Env,
  secrets: Array<{ role: CredentialRole; provider: string; baseUrl: string; model: string; apiKey: string }>,
): Env {
  const next: Env = { ...env };
  const text = secrets.find((item) => item.role === 'text');
  if (text) {
    next.llmProvider = text.provider;
    next.llmBaseUrl = text.baseUrl || undefined;
    next.llmApiKey = text.apiKey || undefined;
    next.llmModel = text.model || undefined;
  }
  const vision = secrets.find((item) => item.role === 'vision');
  if (vision) {
    next.llmVisionProvider = vision.provider;
    next.llmVisionBaseUrl = vision.baseUrl || undefined;
    next.llmVisionApiKey = vision.apiKey || undefined;
    next.llmVisionModel = vision.model || undefined;
  }
  return next;
}
