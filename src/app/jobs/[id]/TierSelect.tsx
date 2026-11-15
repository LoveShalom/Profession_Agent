'use client';

/**
 * 投递定位选择器（F-02 修订：定位可手动覆盖）
 *
 * 默认"跟随分类"（由分类派生主投/副投/碰运气）；也可以手动指定，覆盖分类派生结果。
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { TIER_LABEL, categoryTier } from '@/lib/jobs/category.ts';

type Tier = 'primary' | 'secondary' | 'casual';

interface Props {
  jobId: string;
  category: string | null;
  campaignTier: Tier | null;
}

export default function TierSelect({ jobId, category, campaignTier }: Props) {
  const router = useRouter();
  const [value, setValue] = useState<string>(campaignTier ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const derived = TIER_LABEL[categoryTier(category)];

  async function save(next: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ campaignTier: next === '' ? null : next }),
      });
      const data = (await response.json()) as { ok?: boolean; message?: string };
      if (!data.ok) {
        setError(data.message ?? '保存失败');
        return;
      }
      setValue(next);
      setMessage(next === '' ? `已恢复跟随分类（${derived}）` : `已设为${TIER_LABEL[next as Tier]}`);
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
          投递定位
          <select
            value={value}
            onChange={(event) => void save(event.target.value)}
            style={{ display: 'block', marginTop: 4 }}
            disabled={busy}
          >
            <option value="">跟随分类（{derived}）</option>
            <option value="primary">主投</option>
            <option value="secondary">副投</option>
            <option value="casual">碰运气</option>
          </select>
        </label>
        <span className={`badge${value === 'primary' || (value === '' && derived === '主投') ? ' ok' : value === '' ? ' muted' : ''}`}>
          当前：{value === '' ? derived : TIER_LABEL[value as Tier]}
          {value === '' ? '（自动）' : '（手动）'}
        </span>
      </div>
      {message ? <div className="banner" style={{ marginTop: 8 }}>{message}</div> : null}
      {error ? <div className="banner danger" style={{ marginTop: 8 }}>{error}</div> : null}
      <p className="muted small" style={{ margin: '8px 0 0' }}>
        默认由分类派生；这里手动指定会覆盖分类结果（例如把某个后端岗也标成主投）。
      </p>
    </div>
  );
}
