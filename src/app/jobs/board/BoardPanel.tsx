'use client';

/**
 * 投递看板（F-08 / I3 T5）
 *
 * 零依赖拖拽（Q-10 裁决 A）：原生 HTML5 `draggable` + 键盘 `←/→` 两条等价路径。
 * 交互约定：
 *   · 拖到目标列 → 若需要备注（回退/终态/重新激活）弹窗填写，取消则回弹；
 *   · 键盘：卡片聚焦后 `←/→` 移到相邻列（同样可能弹备注）；
 *   · 先乐观更新本地，失败回滚并显示中文原因（409 冲突会提示刷新）。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { deadlineCountdown, groupJobs, neighborStatus, type BoardJobLike } from '@/lib/jobs/board.ts';
import { categoryLabel, tierLabel } from '@/lib/jobs/category.ts';
import {
  BOARD_COLUMNS,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  decideTransition,
  isJobStatus,
  type JobStatus,
} from '@/lib/status.ts';

interface JobItem extends BoardJobLike {
  reviewFlags?: number[];
}

interface NoteTarget {
  job: JobItem;
  to: JobStatus;
}

const PRIORITY_BADGE: Record<string, string> = { 高: 'badge danger', 中: 'badge', 低: 'badge muted' };

export default function BoardPanel() {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<JobStatus | null>(null);
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/jobs?sort=deadline&limit=200', { cache: 'no-store' });
      const data = (await response.json()) as { ok?: boolean; items?: JobItem[]; error?: string };
      if (!data.ok || !Array.isArray(data.items)) {
        setError(data.error ?? '读取岗位失败');
        return;
      }
      setJobs(data.items);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => groupJobs(jobs), [jobs]);

  /** 真正提交（含备注） */
  const patchStatus = useCallback(async (job: JobItem, to: JobStatus, note?: string) => {
    const previousStatus = job.status;
    setSaving(true);
    setError(null);
    // 乐观更新
    setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, status: to } : item)));
    try {
      const response = await fetch(`/api/jobs/${job.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to, note, from: previousStatus }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        status?: string;
        message?: string;
        code?: string;
        currentStatus?: string;
      };
      if (!data.ok) {
        // 回滚
        setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, status: previousStatus } : item)));
        setError(
          data.code === 'CONFLICT'
            ? `这个岗位的状态刚被别处改过（当前：${data.currentStatus ? STATUS_LABELS[data.currentStatus as JobStatus] ?? data.currentStatus : '未知'}），已刷新`
            : (data.message ?? '状态更新失败'),
        );
        if (data.code === 'CONFLICT') void load();
        return;
      }
      setNotice(`${job.company || job.title}：${data.message ?? '状态已更新'}`);
      setTimeout(() => setNotice(null), 2500);
    } catch (caught) {
      setJobs((current) => current.map((item) => (item.id === job.id ? { ...item, status: previousStatus } : item)));
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setSaving(false);
    }
  }, [load]);

  /** 发起流转：先判定，需要备注就弹窗 */
  const move = useCallback(
    (job: JobItem, to: JobStatus) => {
      if (!isJobStatus(job.status)) {
        setError(`岗位状态「${job.status}」不在枚举内，无法流转`);
        return;
      }
      const decision = decideTransition(job.status, to);
      if (!decision.allowed) {
        setError(decision.reason ?? '不允许的状态流转');
        return;
      }
      if (decision.unchanged) return;
      if (decision.requiresNote) {
        setNoteTarget({ job, to });
        setNoteText('');
        return;
      }
      void patchStatus(job, to);
    },
    [patchStatus],
  );

  const submitNote = useCallback(async () => {
    if (!noteTarget) return;
    const trimmed = noteText.trim();
    if (trimmed.length < 2) {
      setError('备注至少 2 个字（回退/结束/重新激活需要说明）');
      return;
    }
    const target = noteTarget;
    setNoteTarget(null);
    await patchStatus(target.job, target.to, trimmed);
  }, [noteTarget, noteText, patchStatus]);

  const card = (job: JobItem, terminal = false): ReactElement => {
    const status = isJobStatus(job.status) ? job.status : null;
    const countdown = deadlineCountdown(job);
    const dragging = dragId === job.id;
    return (
      <div
        key={job.id}
        className={`board-card${dragging ? ' dragging' : ''}`}
        draggable={status !== null}
        tabIndex={0}
        role="button"
        aria-label={`${job.company || job.title}，当前状态 ${status ? STATUS_LABELS[status] : job.status}；按左右方向键移动`}
        onDragStart={(event) => {
          if (!status) return;
          event.dataTransfer.setData('text/plain', job.id);
          event.dataTransfer.effectAllowed = 'move';
          setDragId(job.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setOverColumn(null);
        }}
        onKeyDown={(event) => {
          if (!status) return;
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const next = neighborStatus(status, event.key === 'ArrowLeft' ? 'left' : 'right');
          if (next) move(job, next);
        }}
      >
        <div className="board-card-title">{job.company || '（未填公司）'}</div>
        <div className="muted small">{job.title}</div>
        <div className="board-card-meta">
          <span className={PRIORITY_BADGE[job.priority] ?? 'badge'}>{job.priority}</span>
          <span className="badge muted">{categoryLabel(job.category)}</span>
          <span className={`badge${tierLabel(job.category) === '主投' ? ' ok' : ' muted'}`}>{tierLabel(job.category)}</span>
          <span className={`badge ${countdown.tone === 'muted' ? '' : countdown.tone}`}>{countdown.label}</span>
          {job.cities.length > 0 ? <span className="muted small">{job.cities[0]}</span> : null}
        </div>
        {terminal ? (
          <div className="muted small" style={{ marginTop: 4 }}>
            按 ←/→ 或拖回其他列可重新激活
          </div>
        ) : null}
      </div>
    );
  };

  const column = (status: JobStatus): ReactElement => {
    const list = grouped.columns.get(status) ?? [];
    return (
      <div
        key={status}
        className={`board-column${overColumn === status ? ' over' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setOverColumn(status);
        }}
        onDragLeave={() => setOverColumn((current) => (current === status ? null : current))}
        onDrop={(event) => {
          event.preventDefault();
          setOverColumn(null);
          const id = event.dataTransfer.getData('text/plain') || dragId;
          setDragId(null);
          const job = jobs.find((item) => item.id === id);
          if (job) move(job, status);
        }}
      >
        <div className="board-column-head">
          <span>{STATUS_LABELS[status]}</span>
          <span className="muted small">{list.length}</span>
        </div>
        <div className="board-cards">
          {list.length === 0 ? <div className="board-empty">拖到这里</div> : null}
          {list.map((job) => card(job))}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
        <span className="muted small">
          共 {jobs.length} 个岗位（拖动卡片或聚焦后按 ←/→ 改状态；回退/结束/重新激活会要求填备注）
        </span>
        <button type="button" className="secondary small" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {notice ? <div className="banner" style={{ marginBottom: 12 }}>{notice}</div> : null}
      {error ? <div className="banner danger" style={{ marginBottom: 12 }}>{error}</div> : null}

      {loading ? (
        <div className="card">
          <p className="muted small" style={{ margin: 0 }}>读取中…</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            还没有岗位。先去 <a href="/jobs/new">粘贴一段 JD</a>，入库后就会出现在「收藏」列。
          </p>
        </div>
      ) : (
        <>
          <div className="board" role="group" aria-label="投递看板">
            {BOARD_COLUMNS.map((status) => column(status))}
          </div>

          <details className="board-terminal" open={grouped.terminal.length > 0}>
            <summary>
              已结束（{grouped.terminal.length}）— {TERMINAL_STATUSES.map((status) => STATUS_LABELS[status]).join(' / ')}
            </summary>
            <div className="board-terminal-cards">{grouped.terminal.map((job) => card(job, true))}</div>
          </details>

          {grouped.unknown.length > 0 ? (
            <div className="banner warn" style={{ marginTop: 12 }}>
              有 {grouped.unknown.length} 个岗位的状态不在 13 枚举内（可能是旧版本数据）：{' '}
              {grouped.unknown.map((job) => `${job.company || job.title}(${job.status})`).join('、')}。
              可在台账里改为合法状态，或删除重建。
            </div>
          ) : null}
        </>
      )}

      {noteTarget ? (
        <div className="modal-mask" role="dialog" aria-modal="true" aria-label="填写流转备注">
          <div className="card modal">
            <h2 style={{ marginTop: 0 }}>
              {noteTarget.job.company || noteTarget.job.title}：{STATUS_LABELS[noteTarget.job.status as JobStatus] ?? noteTarget.job.status} →{' '}
              {STATUS_LABELS[noteTarget.to]}
            </h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              这一步需要备注（回退 / 结束 / 重新激活），写给以后的自己看。
            </p>
            <textarea
              autoFocus
              style={{ minHeight: 90, width: '100%' }}
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              placeholder="例如：拖错列了，退回已投递；或：三面挂，记录一下原因"
            />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="secondary" onClick={() => setNoteTarget(null)} disabled={saving}>
                取消
              </button>
              <button type="button" onClick={() => void submitNote()} disabled={saving}>
                {saving ? '保存中…' : '确认流转'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
