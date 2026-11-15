/**
 * PATCH /api/jobs/[id]/status —— 状态流转（F-08 / I3 T4）
 *
 * 请求：{ to: JobStatus, note?: string, from?: JobStatus }
 *   · `from` 用于乐观并发：与库内不一致 → 409（看板刷新）
 * 响应：成功 { ok, status: 'updated'|'unchanged', job, event?, message }
 *       失败 { ok: false, code, message, hint?, currentStatus? }
 */

import { getJobRepository } from '@/lib/db/factory.ts';
import { transitionJobStatus } from '@/lib/jobs/status-service.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  ILLEGAL_TRANSITION: 422,
  NOTE_REQUIRED: 422,
};

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, code: 'E_BAD_JSON', message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const payload = body as { to?: unknown; note?: unknown; from?: unknown };
  if (typeof payload.to !== 'string' || payload.to.trim().length === 0) {
    return Response.json({ ok: false, code: 'E_BAD_REQUEST', message: '缺少目标状态 to' }, { status: 400 });
  }

  try {
    const repo = await getJobRepository();
    const outcome = await transitionJobStatus(repo, {
      userId: resolveTenant(getEnv()).userId,
      jobId: id,
      to: payload.to,
      note: typeof payload.note === 'string' ? payload.note : null,
      from: typeof payload.from === 'string' ? payload.from : null,
    });

    if (!outcome.ok) {
      const status = STATUS_BY_CODE[outcome.code] ?? 422;
      return Response.json(outcome, { status });
    }
    return Response.json(outcome);
  } catch (error) {
    return Response.json(
      { ok: false, code: 'E_DB', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
