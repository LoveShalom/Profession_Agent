'use client';

/**
 * 状态流转表单（F-08 / I3 T7）
 *
 * 与看板共用同一套规则：`decideTransition` 先判定，需要备注的（回退/终态/重新激活）强制填。
 * 好处是"看板能做的这里都能做"，且错误文案一致。
 */

import { useMemo, useState } from 'react';

import {
  JOB_STATUSES,
  STATUS_LABELS,
  decideTransition,
  isJobStatus,
  validateNote,
  type JobStatus,
} from '@/lib/status.ts';

interface Props {
  jobId: string;
  currentStatus: string;
}

export default function StatusForm({ jobId, currentStatus }: Props) {
  const [status, setStatus] = useState<string>(currentStatus);
  const [to, setTo] = useState<JobStatus>(currentStatus as JobStatus);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decision = useMemo(
    () => (isJobStatus(status) && isJobStatus(to) ? decideTransition(status, to) : null),
    [status, to],
  );

  async function submit() {
    if (!isJobStatus(to)) return;
    if (decision && !decision.allowed) {
      setError(decision.reason ?? '不允许的流转');
      return;
    }
    const noteError = decision ? validateNote(note, decision) : null;
    if (noteError) {
      setError(noteError);
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, from: status, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const data = (await response.json()) as { ok?: boolean; status?: string; message?: string };
      if (!data.ok) {
        setError(data.message ?? '状态更新失败');
        return;
      }
      setMessage(data.status === 'unchanged' ? (data.message ?? '状态未变化') : `已更新：${data.message ?? ''}`);
      if (data.status === 'updated') {
        setStatus(to);
        setNote('');
      }
      // 时间线是服务端渲染的：刷新以显示新事件
      setTimeout(() => window.location.reload(), 600);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {message ? <div className="banner" style={{ marginBottom: 12 }}>{message}</div> : null}
      {error ? <div className="banner danger" style={{ marginBottom: 12 }}>{error}</div> : null}

      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="small">
          目标状态
          <select
            value={to}
            onChange={(event) => {
              setTo(event.target.value as JobStatus);
              setError(null);
            }}
            style={{ display: 'block', marginTop: 4 }}
          >
            {JOB_STATUSES.map((item) => (
              <option key={item} value={item}>
                {STATUS_LABELS[item]}
                {item === (status as JobStatus) ? '（当前）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="small" style={{ flex: 1, minWidth: 260 }}>
          备注{decision?.requiresNote ? '（必填）' : '（可选）'}
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={decision?.requiresNote ? '回退/结束/重新激活需要写一句原因' : '可选'}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          />
        </label>
        <button type="button" onClick={() => void submit()} disabled={busy || !decision?.allowed}>
          {busy ? '提交中…' : '提交流转'}
        </button>
      </div>

      {decision && !decision.allowed ? (
        <p className="muted small" style={{ margin: '8px 0 0' }}>{decision.reason}</p>
      ) : null}
    </div>
  );
}
