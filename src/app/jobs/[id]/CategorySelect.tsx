'use client';

/**
 * 岗位分类选择器（F-02 修订）
 *
 * 分类是"规则派生 + 用户可改"：下拉里给出推荐分类，也允许输入自定义分类 code。
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { JOB_CATEGORIES, categoryLabel, tierLabel } from '@/lib/jobs/category.ts';

interface Props {
  jobId: string;
  category: string | null;
}

export default function CategorySelect({ jobId, category }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(category ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: next.trim() || null }),
      });
      const data = (await response.json()) as { ok?: boolean; message?: string };
      if (!data.ok) {
        setError(data.message ?? '保存失败');
        return;
      }
      setMessage(`已保存：${categoryLabel(next)}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="small">
          岗位分类
          <select
            value={JOB_CATEGORIES.some((item) => item.code === value) ? value : '__custom__'}
            onChange={(event) => {
              const next = event.target.value;
              if (next === '__custom__') return;
              setValue(next);
              void save(next);
            }}
            style={{ display: 'block', marginTop: 4 }}
            disabled={busy}
          >
            {JOB_CATEGORIES.map((item) => (
              <option key={item.code} value={item.code}>
                {item.label}
              </option>
            ))}
            <option value="__custom__">
              {value && !JOB_CATEGORIES.some((item) => item.code === value) ? `自定义：${value}` : '自定义…'}
            </option>
            <option value="">未分类</option>
          </select>
        </label>
        <label className="small" style={{ minWidth: 200 }}>
          或直接填写自定义分类
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="如 algo-medical-imaging / 我的自定义分类"
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          />
        </label>
        <button type="button" className="secondary small" onClick={() => void save(value)} disabled={busy}>
          {busy ? '保存中…' : '保存分类'}
        </button>
      </div>
      {message ? <div className="banner" style={{ marginTop: 8 }}>{message}</div> : null}
      {error ? <div className="banner danger" style={{ marginTop: 8 }}>{error}</div> : null}
      <p className="muted small" style={{ margin: '8px 0 0' }}>
        分类用于筛选与台账「类别」列；「投递定位」（主投/副投/碰运气）由分类自动派生，当前：{tierLabel(value)}。
      </p>
    </div>
  );
}
