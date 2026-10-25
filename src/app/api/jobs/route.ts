/**
 * /api/jobs —— 岗位入库与列表（F-02 / T9）
 *
 *   POST { extraction, forceCreate? } → { status: 'created'|'duplicate'|'blocked', ... }
 *   GET  ?status=&limit=&onlyNeedsReview=1 → 列表
 *
 * 安全约定：**服务端重新校验**客户端提交的 extraction（绝不信任前端），
 * 因此即使用户手工构造请求，也无法绕过"关键字段必须有证据""公司/岗位必填"等规则。
 */

import { JdExtractionSchema } from '@/lib/schemas/jd.ts';
import { isFieldId, type FieldId } from '@/lib/schemas/field-dict.ts';
import { getJobRepository } from '@/lib/db/factory.ts';
import { listJobs, saveJob } from '@/lib/jobs/service.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { getEnv } from '@/lib/server/env.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tenantUserId(): string {
  const tenant = resolveTenant(getEnv());
  return tenant.userId;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: 'E_BAD_JSON', message: '请求体不是合法 JSON' } }, { status: 400 });
  }

  const payload = body as { extraction?: unknown; forceCreate?: unknown; confirmedFields?: unknown; sourceImage?: unknown };
  const parsed = JdExtractionSchema.safeParse(payload.extraction);
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: 'E_INVALID_EXTRACTION',
          message: '提交的字段结构不合法',
          issues: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  // 用户已人工确认的字段（只接受合法的 FieldId，防止前端塞任意字符串绕过校验）
  const confirmedFields = Array.isArray(payload.confirmedFields)
    ? payload.confirmedFields.filter((id): id is FieldId => typeof id === 'string' && isFieldId(id))
    : [];

  // 来源截图：只接受工作区附件目录下的相对路径（防目录穿越 / 任意路径写入）
  const sourceImage =
    typeof payload.sourceImage === 'string' &&
    payload.sourceImage.startsWith('原始JD/attachments/') &&
    !payload.sourceImage.includes('..')
      ? payload.sourceImage
      : undefined;

  try {
    const repo = await getJobRepository();
    const result = await saveJob(repo, {
      userId: tenantUserId(),
      extraction: parsed.data,
      forceCreate: payload.forceCreate === true,
      ...(confirmedFields.length > 0 ? { confirmedFields } : {}),
      ...(sourceImage ? { sourceImage } : {}),
    });
    const statusCode = result.status === 'blocked' ? 422 : result.status === 'duplicate' ? 409 : 201;
    return Response.json(result, { status: statusCode });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: { code: 'E_DB', message } }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const status = url.searchParams.get('status') ?? undefined;
  const onlyNeedsReview = url.searchParams.get('onlyNeedsReview') === '1';

  try {
    const repo = await getJobRepository();
    const result = await listJobs(repo, tenantUserId(), {
      limit: Number.isFinite(limit) ? limit : 50,
      ...(status ? { status } : {}),
      onlyNeedsReview,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: { code: 'E_DB', message } }, { status: 500 });
  }
}
