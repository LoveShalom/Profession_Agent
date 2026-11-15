/**
 * 岗位详情 + 状态时间线（F-08 / I3 T7）
 *
 * 只读部分服务端渲染；流转表单是客户端组件（需要乐观反馈）。
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { getJobRepository } from '@/lib/db/factory.ts';
import { listJobTimeline } from '@/lib/jobs/status-service.ts';
import { getEnv } from '@/lib/server/env.ts';
import { categoryLabel, tierLabel } from '@/lib/jobs/category.ts';
import { STATUS_LABELS, isJobStatus } from '@/lib/status.ts';
import { resolveTenant } from '@/lib/tenant.ts';

import CategorySelect from './CategorySelect.tsx';
import TierSelect from './TierSelect.tsx';
import JobRowActions from '../JobRowActions.tsx';
import StatusForm from './StatusForm.tsx';

export const metadata: Metadata = { title: '岗位详情 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function JobDetailPage({ params }: PageProps) {
  const { id } = await params;

  let timeline;
  try {
    const repo = await getJobRepository();
    timeline = await listJobTimeline(repo, {
      userId: resolveTenant(getEnv()).userId,
      jobId: id,
      limit: 100,
    });
  } catch (error) {
    return (
      <main className="container">
        <div className="card">
          <div className="banner danger">
            <b>无法读取数据库：</b>
            {error instanceof Error ? error.message : String(error)}
          </div>
        </div>
      </main>
    );
  }
  if (!timeline) notFound();

  const { job, events } = timeline;
  const statusLabel = isJobStatus(job.status) ? STATUS_LABELS[job.status] : job.status;

  return (
    <main className="container">
      <div className="page-header">
        <h1>{job.company || '（未填公司）'}</h1>
        <div className="row">
          <a className="small" href="/jobs">
            返回列表
          </a>
          <a className="small" href="/jobs/board">
            投递看板
          </a>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>{job.title || '（未填岗位）'}</h2>
          <div className="row">
            <span className="badge muted">{categoryLabel(job.category)}</span>
            <span className={`badge${tierLabel(job.category) === '主投' ? ' ok' : tierLabel(job.category) === '副投' ? '' : ' muted'}`}>
              {tierLabel(job.category)}
            </span>
            <span className="badge">{statusLabel}</span>
            <JobRowActions jobId={job.id} deleted={job.deletedAt !== null} />
          </div>
        </div>
        <div className="field-grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label>城市</label>
            <div className="value small">{job.cities.join(' / ') || '—'}</div>
          </div>
          <div className="field">
            <label>截止</label>
            <div className="value small">
              {job.deadline_kind === 'provided' && job.deadline
                ? job.deadline.slice(0, 10)
                : job.deadline_kind === 'text_only'
                  ? (job.deadline_text ?? '见原文')
                  : '未提供'}
            </div>
          </div>
          <div className="field">
            <label>优先级</label>
            <div className="value small">{job.priority}</div>
          </div>
          <div className="field">
            <label>技能</label>
            <div className="value small">{job.skills.join('; ') || '—'}</div>
          </div>
          <div className="field">
            <label>备注</label>
            <div className="value small">{job.notes || '—'}</div>
          </div>
          <div className="field">
            <label>更新时间</label>
            <div className="value small">{job.updatedAt.slice(0, 19).replace('T', ' ')}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>岗位分类</h2>
        <CategorySelect jobId={job.id} category={job.category} />
      </div>

      <div className="card">
        <h2>投递定位</h2>
        <TierSelect jobId={job.id} category={job.category} campaignTier={job.campaignTier} />
      </div>

      <div className="card">
        <h2>状态流转</h2>
        <StatusForm jobId={job.id} currentStatus={job.status} />
      </div>

      <div className="card">
        <h2>时间线（{events.length}）</h2>
        {events.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            还没有流转记录。入库时的初始状态是「{STATUS_LABELS.saved}」。
          </p>
        ) : (
          <ol className="timeline">
            {events.map((event) => (
              <li key={event.id}>
                <div className="timeline-head">
                  <span>
                    {isJobStatus(event.fromStatus) ? STATUS_LABELS[event.fromStatus] : event.fromStatus} →{' '}
                    {isJobStatus(event.toStatus) ? STATUS_LABELS[event.toStatus] : event.toStatus}
                  </span>
                  {event.isRollback ? <span className="badge warn">回退</span> : null}
                  {event.isReactivation ? <span className="badge warn">重新激活</span> : null}
                  <span className="muted small">{event.occurredAt.slice(0, 19).replace('T', ' ')}</span>
                </div>
                {event.note ? <div className="small" style={{ marginTop: 4 }}>{event.note}</div> : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="card">
        <h2>原始 JD</h2>
        <pre style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{job.raw_text}</pre>
      </div>
    </main>
  );
}
