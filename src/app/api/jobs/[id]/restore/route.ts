/**
 * POST /api/jobs/[id]/restore —— 恢复软删除的岗位
 */

import { getJobRepository } from '@/lib/db/factory.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const repo = await getJobRepository();
    const userId = resolveTenant(getEnv()).userId;
    const done = await repo.restore(userId, id);
    if (!done) return Response.json({ ok: false, message: '岗位不存在或未被删除' }, { status: 404 });
    return Response.json({ ok: true, message: '已恢复' });
  } catch (error) {
    return Response.json({ ok: false, message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
