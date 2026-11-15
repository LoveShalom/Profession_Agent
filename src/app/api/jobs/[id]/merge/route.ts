/**
 * POST /api/jobs/[id]/merge —— 合并重复 JD（F-08 / I3 T8）
 *
 * 请求：{ extraction: JdExtraction }（确认页当前抽取结果）
 * 响应：{ ok, status: 'merged'|'no_change', filled, messages, job }
 */

import { getJobRepository } from '@/lib/db/factory.ts';
import { mergeDuplicateJob } from '@/lib/jobs/merge.ts';
import { JdExtractionSchema } from '@/lib/schemas/jd.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, code: 'E_BAD_JSON', message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const parsed = JdExtractionSchema.safeParse((body as { extraction?: unknown }).extraction);
  if (!parsed.success) {
    return Response.json(
      { ok: false, code: 'E_BAD_EXTRACTION', message: '抽取结果结构不合法，无法合并' },
      { status: 400 },
    );
  }

  try {
    const repo = await getJobRepository();
    const result = await mergeDuplicateJob(repo, {
      userId: resolveTenant(getEnv()).userId,
      jobId: id,
      extraction: parsed.data,
    });
    if (result.status === 'not_found') {
      return Response.json({ ok: false, code: 'NOT_FOUND', message: result.messages[0] }, { status: 404 });
    }
    if (result.status === 'invalid') {
      return Response.json({ ok: false, code: 'E_INVALID', message: result.messages[0] }, { status: 422 });
    }
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      { ok: false, code: 'E_DB', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
