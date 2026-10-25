/**
 * /api/settings/credentials —— 模型凭证（F-07）
 *
 *   GET    → 脱敏列表（只含 keyLast4，绝不返回明文）
 *   POST   → 保存（先 probe，坏凭证不落库）
 *   DELETE → 删除（?provider=&baseUrl=），删除后回退 .env
 */

import { createCredentialStore, saveCredential, type CredentialRole } from '@/lib/credentials/store.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function context() {
  const env = getEnv();
  const tenant = resolveTenant(env);
  const store = await createCredentialStore(env.databaseUrl);
  return { env, userId: tenant.userId, store };
}

export async function GET(): Promise<Response> {
  try {
    const { userId, store } = await context();
    return Response.json({ ok: true, credentials: await store.list(userId) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const payload = body as { role?: unknown; provider?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown };
  const role: CredentialRole = payload.role === 'vision' ? 'vision' : 'text';
  const provider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
  if (provider.length === 0) return Response.json({ ok: false, error: '请选择服务商' }, { status: 400 });

  try {
    const { env, userId, store } = await context();
    const result = await saveCredential({
      store,
      userId,
      env,
      input: {
        role,
        provider,
        baseUrl: typeof payload.baseUrl === 'string' && payload.baseUrl.trim().length > 0 ? payload.baseUrl.trim() : undefined,
        model: typeof payload.model === 'string' && payload.model.trim().length > 0 ? payload.model.trim() : undefined,
        apiKey: typeof payload.apiKey === 'string' ? payload.apiKey : '',
      },
    });
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 422 });
    return Response.json({ ok: true, summary: result.summary, credentials: await store.list(userId) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider') ?? '';
  const baseUrl = url.searchParams.get('baseUrl') ?? '';
  try {
    const { userId, store } = await context();
    const removed = await store.remove(userId, provider, baseUrl);
    if (!removed) return Response.json({ ok: false, error: '未找到该凭证' }, { status: 404 });
    return Response.json({ ok: true, credentials: await store.list(userId) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
