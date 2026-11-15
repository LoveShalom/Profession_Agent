'use client';

/**
 * 岗位行操作：删除 / 恢复（软删除，可恢复）
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  jobId: string;
  deleted: boolean;
}

export default function JobRowActions({ jobId, deleted }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: 'delete' | 'restore') {
    if (kind === 'delete' && !window.confirm('删除这个岗位？（可在"显示已删除"里恢复）')) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(kind === 'delete' ? `/api/jobs/${jobId}` : `/api/jobs/${jobId}/restore`, {
        method: kind === 'delete' ? 'DELETE' : 'POST',
      });
      const data = (await response.json()) as { ok?: boolean; message?: string };
      if (!data.ok) {
        setError(data.message ?? '操作失败');
        return;
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <a className="small" href={`/jobs/${jobId}`}>
        详情
      </a>
      <button
        type="button"
        className="secondary small"
        disabled={busy}
        onClick={() => void act(deleted ? 'restore' : 'delete')}
      >
        {busy ? '…' : deleted ? '恢复' : '删除'}
      </button>
      {error ? <span className="muted small">{error}</span> : null}
    </span>
  );
}
