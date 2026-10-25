/**
 * POST /api/ocr —— 截图识别（F-04 / T2）
 *
 * **多模型路由**：这里用 `LLM_VISION_*` 配置的视觉模型，而不是文本模型。
 * 未配置视觉模型时返回可操作提示（不是 500，也不影响文本抽取）。
 *
 * 请求：`{ images: string[] }`（data URL，1–5 张）
 * 响应：成功 `{ ok: true, text, engine: 'vlm', model, imageCount, warnings }`
 *       失败 `{ ok: false, code, message, hint?, suggestions? }`
 */

import { ProviderError } from '@/lib/errors.ts';
import { saveAttachment } from '@/lib/ocr/attachments.ts';
import { recognizeImages } from '@/lib/ocr/recognize.ts';
import { getModelRouter } from '@/lib/server/models.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, code: 'E_BAD_JSON', message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const payload = body as { images?: unknown };
  const images = Array.isArray(payload.images)
    ? payload.images.filter((item): item is string => typeof item === 'string')
    : [];

  try {
    const router = await getModelRouter();
    const visionInfo = router.info.vision;

    if (!router.vision) {
      return Response.json(
        {
          ok: false,
          code: 'E_OCR_UNAVAILABLE',
          message: visionInfo.reason ?? '未配置视觉模型，截图识别不可用',
          hint:
            '在 .env 里加三行即可启用（可与文本模型不同厂商）：\n' +
            '  LLM_VISION_PROVIDER=qwen\n' +
            '  LLM_VISION_MODEL=qwen-vl-plus\n' +
            '  LLM_VISION_API_KEY=sk-...   # 与文本模型同一家时可省略这行（继承 LLM_API_KEY）',
          suggestions: visionInfo.suggestions ?? [],
        },
        { status: 422 },
      );
    }

    const result = await recognizeImages(images, {
      service: router.vision,
      provider: visionInfo.provider,
      model: visionInfo.model,
    });

    if (!result.ok) {
      const status = result.code.startsWith('E_IMAGE') ? 400 : 422;
      return Response.json(result, { status });
    }
    // 附件落盘：截图是「系统有没有看错」的唯一证据（F-04 T4）
    let attachment: string | null = null;
    try {
      const saved = saveAttachment(images[0]!);
      attachment = saved.relativePath;
    } catch {
      // 存档失败不影响识别结果，只是少了证据
    }

    return Response.json({ ...result, model: visionInfo.model, attachment });
  } catch (error) {
    if (error instanceof ProviderError) {
      return Response.json(
        { ok: false, code: 'E_OCR_FAILED', message: error.message, hint: error.userHint },
        { status: 400 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, code: 'E_OCR_FAILED', message }, { status: 500 });
  }
}
