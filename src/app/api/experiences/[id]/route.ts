/**
 * /api/experiences/[id] —— 单条经历（F-05）
 *
 *   GET    → 详情
 *   PATCH  → 更新（body.form）；body.restore === true 时为"恢复软删"
 *   DELETE → 软删除（不物理删，可恢复）
 */

import { getExperienceRepository } from '@/lib/experience/factory.ts';
import { ExperienceFormSchema } from '@/lib/schemas/experience.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function userId(): string {
  return resolveTenant(getEnv()).userId;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const repo = await getExperienceRepository();
    const experience = await repo.findById(userId(), id);
    if (!experience) return Response.json({ error: '经历不存在' }, { status: 404 });
    return Response.json({ ok: true, experience });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const payload = body as { form?: unknown; restore?: unknown };

  try {
    const repo = await getExperienceRepository();
    if (payload.restore === true) {
      const ok = await repo.restore(userId(), id);
      if (!ok) return Response.json({ error: '该经历不在回收状态或不存在' }, { status: 409 });
      return Response.json({ ok: true, status: 'restored' });
    }

    const parsed = ExperienceFormSchema.safeParse(payload.form);
    if (!parsed.success) {
      return Response.json(
        {
          error: '字段不合法',
          issues: parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
        { status: 400 },
      );
    }
    const updated = await repo.update(userId(), id, parsed.data);
    if (!updated) return Response.json({ error: '经历不存在' }, { status: 404 });
    return Response.json({ ok: true, status: 'updated', experience: updated });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const repo = await getExperienceRepository();
    const ok = await repo.softDelete(userId(), id);
    if (!ok) return Response.json({ error: '经历不存在或已删除' }, { status: 404 });
    return Response.json({ ok: true, status: 'deleted', restoreHint: '可通过 PATCH { restore: true } 恢复' });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
