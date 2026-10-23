/**
 * POST /api/parse-jd —— 解析 JD（**不落库**）（F-02 / T9）
 *
 * 契约（对应 F-02 §1.2）：
 *   请求 { rawText: string, source?: 'manual'|'plugin'|'import', sourceUrl?: string|null }
 *   响应 { ok, errors, warnings, level, degraded, path, banner?, consistency?, extraction, validation, meta }
 *
 * 设计要点：
 *   · **不落库**：解析与入库分成两个接口，用户可以先改字段再提交（AC-2 强制确认）；
 *   · 无 Key 也能用：`createLLM` 在无凭证时仍返回服务对象，`extractJd` 会自动走规则模式（L4）；
 *   · 配置错误（如 custom 缺 baseUrl）返回 400 + 修复建议，而不是 500。
 */

import { ProviderError } from '@/lib/errors.ts';
import { extractJd } from '@/lib/llm/extract.ts';
import { createLLM } from '@/lib/llm/index.ts';
import { describeBlockers } from '@/lib/pipeline/validate.ts';
import { getEnv } from '@/lib/server/env.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_INPUT = 200_000;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: 'E_BAD_JSON', message: '请求体不是合法 JSON' } }, { status: 400 });
  }

  const payload = body as { rawText?: unknown; source?: unknown; sourceUrl?: unknown };
  const rawText = typeof payload.rawText === 'string' ? payload.rawText : '';
  if (rawText.trim().length === 0) {
    return Response.json({ error: { code: 'E_EMPTY', message: 'JD 原文为空' } }, { status: 400 });
  }
  if (rawText.length > MAX_INPUT) {
    return Response.json(
      { error: { code: 'E_TOO_LONG', message: `JD 过长（${rawText.length} 字符，上限 ${MAX_INPUT}）` } },
      { status: 413 },
    );
  }

  // 输入层的 source 是三态（manual/plugin/import），而 DB 枚举是
  // manual/guopin/ncss/resume_import/plugin —— 文件导入在语义上属于"用户手动提供"，
  // 因此映射为 manual（来源渠道可在 channel/source_url 里细化）。
  const source: 'manual' | 'plugin' = payload.source === 'plugin' ? 'plugin' : 'manual';
  const sourceUrl = typeof payload.sourceUrl === 'string' && payload.sourceUrl.length > 0 ? payload.sourceUrl : undefined;

  try {
    const env = getEnv();
    const service = createLLM(env, {});
    const result = await extractJd(
      { rawText, source, ...(sourceUrl !== undefined ? { sourceUrl } : {}) },
      { service, sampleK: env.sampleK },
    );

    return Response.json({
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      level: result.level,
      degraded: result.degraded,
      path: result.path,
      ...(result.banner ? { banner: result.banner } : {}),
      ...(result.consistency ? { consistency: result.consistency } : {}),
      extraction: result.extraction,
      validation: {
        ok: result.validation.ok,
        blockers: result.validation.blockers,
        messages: describeBlockers(result.validation.blockers),
        needsReview: result.validation.needsReview,
      },
      meta: {
        charCount: result.clean.charCount,
        language: result.clean.language,
        segmentCount: result.clean.segments.length,
        piiFlags: result.clean.piiFlags,
        injectionDetected: result.clean.injectionDetected,
        deadline: result.deadline,
        sampling: result.consistency?.sampleCount ?? 1,
      },
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return Response.json(
        { error: { code: 'E_PROVIDER_CONFIG', kind: error.kind, message: error.message, hint: error.userHint } },
        { status: 400 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: { code: 'E_INTERNAL', message } }, { status: 500 });
  }
}
