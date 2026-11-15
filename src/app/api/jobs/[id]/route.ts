/**
 * PATCH /api/jobs/[id] —— 编辑岗位字段（F-02 修订：分类标签 / 优先级 / 备注）
 * DELETE /api/jobs/[id] —— 软删除岗位（可在列表"显示已删除"里恢复）
 */

import { getJobRepository } from '@/lib/db/factory.ts';
import { resolveJobPatch } from '@/lib/jobs/service.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const parsed = resolveJobPatch(body as Record<string, unknown>);
  if (!parsed.ok) return Response.json({ ok: false, message: parsed.message }, { status: 400 });
  if (Object.keys(parsed.patch).length === 0) {
    return Response.json({ ok: false, message: '没有可更新的字段' }, { status: 400 });
  }

  try {
    const repo = await getJobRepository();
    const userId = resolveTenant(getEnv()).userId;
    const job = await repo.update(userId, id, parsed.patch);
    if (!job) return Response.json({ ok: false, message: '岗位不存在或已删除' }, { status: 404 });
    return Response.json({ ok: true, job });
  } catch (error) {
    return Response.json({ ok: false, message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const repo = await getJobRepository();
    const userId = resolveTenant(getEnv()).userId;
    const done = await repo.softDelete(userId, id);
    if (!done) return Response.json({ ok: false, message: '岗位不存在或已被删除' }, { status: 404 });
    return Response.json({ ok: true, message: '已删除（可在"显示已删除"里恢复）' });
  } catch (error) {
    return Response.json({ ok: false, message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
