'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * 截图输入（F-04 / T3）
 *
 * 三种入口：Ctrl+V 粘贴 / 拖拽 / 选文件。
 * 长截图**在浏览器里切片**（重叠 10%），这样服务端不需要任何图像处理依赖；
 * 识别完成后把文本交给父组件（父组件负责填进文本框并走 /api/parse-jd）。
 */

const MAX_IMAGES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const SLICE_HEIGHT = 1600;
const SLICE_OVERLAP = 160;

interface ImageItem {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  slices: number;
  /** 长截图切片后的 data URL（未切片时就是 [dataUrl]） */
  sliceUrls: string[];
}

interface OcrResponse {
  ok?: boolean;
  text?: string;
  imageCount?: number;
  attachment?: string | null;
  warnings?: string[];
  code?: string;
  message?: string;
  hint?: string;
  suggestions?: string[];
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = dataUrl;
  });
}

/** 长图切片：每片高 1600px、相邻重叠 160px（由服务端做行级去重） */
async function sliceLongImage(dataUrl: string, image: HTMLImageElement): Promise<string[]> {
  const ratio = image.height / image.width;
  const needSlice = image.height > SLICE_HEIGHT * 1.5 && ratio > 2.5;
  if (!needSlice) return [dataUrl];

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return [dataUrl];

  canvas.width = image.width;
  canvas.height = SLICE_HEIGHT;
  const slices: string[] = [];
  let offset = 0;
  while (offset < image.height) {
    const height = Math.min(SLICE_HEIGHT, image.height - offset);
    canvas.height = height;
    context.clearRect(0, 0, canvas.width, height);
    context.drawImage(image, 0, offset, image.width, height, 0, 0, image.width, height);
    slices.push(canvas.toDataURL('image/jpeg', 0.9));
    if (offset + height >= image.height) break;
    offset += SLICE_HEIGHT - SLICE_OVERLAP;
  }
  return slices;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export default function ImageInput({
  onText,
}: {
  onText: (text: string, meta?: { attachment?: string }) => void;
}) {
  const [items, setItems] = useState<ImageItem[]>([]);
  const [status, setStatus] = useState<'idle' | 'preparing' | 'recognizing'>('idle');
  const [error, setError] = useState<OcrResponse | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      setNote(null);
      const accepted = files.filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type));
      if (accepted.length === 0) {
        setError({ code: 'E_IMAGE_UNSUPPORTED', message: '请粘贴或选择 PNG / JPEG / WebP 截图' });
        return;
      }
      setStatus('preparing');
      try {
        const prepared: ImageItem[] = [];
        for (const file of accepted) {
          if (file.size > MAX_BYTES) {
            setError({ code: 'E_IMAGE_UNSUPPORTED', message: `${file.name || '图片'} 超过 10MB，请先裁剪或压缩` });
            continue;
          }
          const dataUrl = await readAsDataUrl(file);
          const image = await loadImage(dataUrl);
          const slices = await sliceLongImage(dataUrl, image);
          prepared.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            dataUrl,
            width: image.width,
            height: image.height,
            slices: slices.length,
            sliceUrls: slices,
          });
        }
        setItems((previous) => {
          const merged = [...previous, ...prepared];
          if (merged.length > MAX_IMAGES) {
            setError({ code: 'E_IMAGE_TOO_MANY', message: `最多 ${MAX_IMAGES} 张图片` });
            return merged.slice(0, MAX_IMAGES);
          }
          return merged;
        });
      } catch (caught) {
        setError({ code: 'E_IMAGE_UNSUPPORTED', message: caught instanceof Error ? caught.message : '图片处理失败' });
      } finally {
        setStatus('idle');
      }
    },
    [],
  );

  async function recognize() {
    if (items.length === 0) return;
    setStatus('recognizing');
    setError(null);
    setNote(null);
    try {
      const payload = items.flatMap((item) => item.sliceUrls);
      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ images: payload }),
      });
      const data = (await response.json()) as OcrResponse;
      if (!response.ok || data.ok !== true || typeof data.text !== 'string') {
        setError(data);
        return;
      }
      setNote(
        `已识别 ${data.imageCount ?? items.length} 张图片${data.warnings?.length ? `（${data.warnings.join('；')}）` : ''}` +
          (data.attachment ? '；原图已存档到工作区' : ''),
      );
      onText(data.text, { ...(data.attachment ? { attachment: data.attachment } : {}) });
      setItems([]);
    } catch (caught) {
      setError({ code: 'E_OCR_FAILED', message: caught instanceof Error ? caught.message : '网络错误' });
    } finally {
      setStatus('idle');
    }
  }

  const busy = status !== 'idle';

  return (
    <div>
      <div
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files ?? []);
          if (files.length > 0) {
            event.preventDefault();
            void addFiles(files);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void addFiles(Array.from(event.dataTransfer.files ?? []));
        }}
        style={{
          border: '2px dashed var(--border)',
          borderRadius: 10,
          padding: '28px 16px',
          textAlign: 'center',
          background: '#fafafa',
        }}
      >
        <p style={{ margin: '0 0 8px' }}>
          <b>Ctrl+V 直接粘贴截图</b>，或把图片拖到这里
        </p>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          适用于禁止复制的招聘网站；长截图会自动切片。支持 PNG / JPEG / WebP，单张 ≤10MB，最多 {MAX_IMAGES} 张
        </p>
        <button type="button" className="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
          选择图片文件
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => {
            void addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>

      {items.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            {items.map((item, index) => (
              <div key={item.id} className="field" style={{ padding: 6 }}>
                <img
                  src={item.dataUrl}
                  alt={`截图 ${index + 1}`}
                  style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 6, display: 'block' }}
                />
                <div className="muted small" style={{ marginTop: 4 }}>
                  {item.width}×{item.height}
                  {item.slices > 1 ? ` · ${item.slices} 片` : ''}
                </div>
                <button
                  type="button"
                  className="secondary small"
                  style={{ padding: '2px 6px', marginTop: 4 }}
                  onClick={() => setItems((previous) => previous.filter((one) => one.id !== item.id))}
                  disabled={busy}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" onClick={() => void recognize()} disabled={busy}>
              {status === 'recognizing' ? '识别中…' : status === 'preparing' ? '处理图片…' : '识别文字'}
            </button>
            <span className="muted small">
              识别后文字会填入上方文本框，你可以先核对再解析
            </span>
          </div>
        </div>
      ) : null}

      {note ? <div className="banner" style={{ marginTop: 12 }}>{note}</div> : null}

      {error ? (
        <div className="banner danger" style={{ marginTop: 12 }}>
          <b>{error.message ?? '识别失败'}</b>
          {error.hint ? <div className="small" style={{ marginTop: 4 }}>{error.hint}</div> : null}
          {error.suggestions && error.suggestions.length > 0 ? (
            <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
              {error.suggestions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <div className="small muted" style={{ marginTop: 6 }}>
            也可以直接 Ctrl+V 粘贴 JD 文字，不影响其它功能。
          </div>
        </div>
      ) : null}
    </div>
  );
}
