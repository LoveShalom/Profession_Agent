/**
 * /api/experiences —— 经历库（F-05）
 *
 *   GET  ?type=&includeDeleted=1 → 列表摘要
 *   POST { form } 或 { rawText } → 新建（rawText 时先走规则 STAR 抽取，返回 draft 供确认）
 *
 * 注意：`rawText` 模式**只返回草稿**（status: 'draft'），必须由用户确认后再用 form 提交，
 * 避免把规则抽取的猜测直接写入经历库（与 F-02 的"强制确认"一致）。
 */

import { getExperienceRepository } from '@/lib/experience/factory.ts';
import { listExperiences, saveExperience } from '@/lib/experience/service.ts';
import { createModelRouter } from '@/lib/llm/profiles.ts';
import { extractExperienceStructured } from '@/lib/llm/experience.ts';
import {
  EXPERIENCE_TYPES,
  ExperienceFormSchema,
  isResumeReady,
  type ExperienceType,
} from '@/lib/schemas/experience.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const typeParam = url.searchParams.get('type') ?? undefined;
  const type = typeParam && (EXPERIENCE_TYPES as readonly string[]).includes(typeParam) ? (typeParam as ExperienceType) : undefined;
  try {
    const userId = resolveTenant(getEnv()).userId;
    const repo = await getExperienceRepository();
    const result = await listExperiences(repo, userId, {
      ...(type ? { type } : {}),
      includeDeleted: url.searchParams.get('includeDeleted') === '1',
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const payload = body as { form?: unknown; rawText?: unknown; forceCreate?: unknown };

  // ① 自由文本模式：返回 STAR 草稿，不写库
  if (typeof payload.rawText === 'string' && payload.form === undefined) {
    const rawText = payload.rawText.trim();
    if (rawText.length < 20) {
      return Response.json({ error: '描述太短（至少 20 字），请多写几句做了什么' }, { status: 400 });
    }
    if (rawText.length > 8000) {
      return Response.json({ error: '描述过长（上限 8000 字），请先精简' }, { status: 413 });
    }
    // 有模型就归纳（不是切原文），无模型/失败自动回退规则切分
    let service = null;
    try {
      service = createModelRouter(getEnv()).text;
    } catch {
      service = null;
    }
    const result = await extractExperienceStructured({ rawText, service });
    return Response.json({
      ok: true,
      status: 'draft',
      engine: result.engine,
      level: result.level,
      degraded: result.degraded,
      warnings: result.warnings,
      ...(result.banner ? { banner: result.banner } : {}),
      extraction: result.extraction,
      resumeReady: isResumeReady(result.extraction),
    });
  }

  // ② 表单模式：校验后落库
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

  try {
    const userId = resolveTenant(getEnv()).userId;
    const repo = await getExperienceRepository();
    const result = await saveExperience(repo, {
      userId,
      form: parsed.data,
      forceCreate: payload.forceCreate === true,
    });
    return Response.json(
      {
        ok: true,
        status: result.status,
        experience: result.experience,
        ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}),
      },
      { status: result.status === 'created' ? 201 : 200 },
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
