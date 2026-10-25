/**
 * POST /api/resume/import —— 简历导入（F-06）
 *
 * 请求：{ fileName, mime, dataBase64 }（≤10MB）
 * 响应：{ ok, format, pageCount, warnings, candidates: [{ extraction, rawText, dedupeKey }] }
 *
 * **只解析、不入库**：候选经历必须由用户在确认页逐条勾选后再调 /api/experiences。
 * 扫描件（无文字层）返回 E_NO_TEXT_LAYER + 两条替代路径。
 */

import { segmentResumeWithLLM } from '@/lib/llm/experience.ts';
import { parseResume, ResumeImportError } from '@/lib/resume/import.ts';
import { getModelRouter } from '@/lib/server/models.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BASE64 = Math.ceil((10 * 1024 * 1024 * 4) / 3);

const STATUS: Record<ResumeImportError['code'], number> = {
  E_UNSUPPORTED_FORMAT: 415,
  E_TOO_LARGE: 413,
  E_DEPENDENCY_MISSING: 501,
  E_PARSE_FAILED: 422,
  E_NO_TEXT_LAYER: 422,
  E_NO_EXPERIENCE: 422,
};

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, code: 'E_BAD_JSON', message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const payload = body as { fileName?: unknown; mime?: unknown; dataBase64?: unknown };
  const fileName = typeof payload.fileName === 'string' ? payload.fileName : '';
  const mime = typeof payload.mime === 'string' ? payload.mime : '';
  const dataBase64 = typeof payload.dataBase64 === 'string' ? payload.dataBase64 : '';

  if (dataBase64.length === 0) {
    return Response.json({ ok: false, code: 'E_EMPTY', message: '没有收到文件内容' }, { status: 400 });
  }
  if (dataBase64.length > MAX_BASE64) {
    return Response.json({ ok: false, code: 'E_TOO_LARGE', message: '文件超过 10MB' }, { status: 413 });
  }

  try {
    const parsed = await parseResume({ name: fileName, mime, data: Buffer.from(dataBase64, 'base64') });
    // 有模型 → AI 切分（能读懂双栏 PDF 的乱序语义）；无模型/失败 → 规则切分
    let service = null;
    try {
      service = (await getModelRouter()).text;
    } catch {
      service = null;
    }
    const segmented = await segmentResumeWithLLM({ rawText: parsed.text, service });
    const candidates = segmented.candidates;
    return Response.json({
      ok: true,
      format: parsed.format,
      pageCount: parsed.pageCount,
      hasTextLayer: parsed.hasTextLayer,
      warnings: [...parsed.warnings, ...segmented.warnings],
      engine: segmented.engine,
      level: segmented.level,
      candidates,
      textPreview: parsed.text.slice(0, 400),
    });
  } catch (error) {
    if (error instanceof ResumeImportError) {
      return Response.json(
        { ok: false, code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) },
        { status: STATUS[error.code] ?? 422 },
      );
    }
    return Response.json({ ok: false, code: 'E_PARSE_FAILED', message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
