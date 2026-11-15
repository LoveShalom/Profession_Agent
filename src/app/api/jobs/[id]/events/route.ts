/**
 * GET /api/jobs/[id]/events —— 状态流转时间线（F-08 / I3 T4）
 *
 * 响应：{ ok: true, job: { id, company, title, status }, events: [{ fromStatus, toStatus, note, isRollback, isReactivation, occurredAt }] }
 */

import { getJobRepository } from '@/lib/db/factory.ts';
import { listJobTimeline } from '@/lib/jobs/status-service.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '50');

  try {
    const repo = await getJobRepository();
    const timeline = await listJobTimeline(repo, {
      userId: resolveTenant(getEnv()).userId,
      jobId: id,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    if (!timeline) {
      return Response.json({ ok: false, code: 'NOT_FOUND', message: '岗位不存在或已删除' }, { status: 404 });
    }
    return Response.json({
      ok: true,
      job: {
        id: timeline.job.id,
        company: timeline.job.company,
        title: timeline.job.title,
        status: timeline.job.status,
      },
      events: timeline.events,
    });
  } catch (error) {
    return Response.json(
      { ok: false, code: 'E_DB', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
