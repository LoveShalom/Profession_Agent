/**
 * 岗位列表（F-08 / I3 T6）
 *
 * 相比 I1 的最小版，本页补上：
 *   · 状态中文名（不再是 `to_apply` 这种枚举值）
 *   · 截止倒计时角标（T-N / 今天截止 / 已过期 / 未提供）
 *   · 按状态筛选（`?status=`）
 *   · 进入岗位详情（状态时间线）
 */

import type { Metadata } from 'next';

import { getJobRepository } from '@/lib/db/factory.ts';

import JobRowActions from './JobRowActions.tsx';
import { deadlineCountdown } from '@/lib/jobs/board.ts';
import { JOB_CATEGORIES, categoryLabel } from '@/lib/jobs/category.ts';
import { listJobs } from '@/lib/jobs/service.ts';
import { getEnv } from '@/lib/server/env.ts';
import { JOB_STATUSES, STATUS_LABELS, isJobStatus } from '@/lib/status.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const metadata: Metadata = { title: '岗位列表 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ status?: string; category?: string; deleted?: string; tier?: string }>;
}

const FILTERS = [{ value: '', label: '全部' }].concat(
  JOB_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
);

export default async function JobsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const statusFilter = params.status && isJobStatus(params.status) ? params.status : '';
  const categoryFilter = params.category ?? '';
  const includeDeleted = params.deleted === '1';
  const tierFilter = params.tier === 'primary' || params.tier === 'secondary' || params.tier === 'casual' ? params.tier : '';

  let body: React.ReactNode;
  let deletedCount = 0;

  try {
    const env = getEnv();
    const tenant = resolveTenant(env);
    const repo = await getJobRepository();
    const result = await listJobs(repo, tenant.userId, {
      limit: 200,
      sort: 'deadline',
      includeDeleted,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(categoryFilter ? { category: categoryFilter } : {}),
      ...(tierFilter ? { tier: tierFilter } : {}),
    });

    // 已删除数量：让「显示已删除」入口显眼（用户找不到它就是因为没数字提示）
    const allJobs = await repo.list(tenant.userId, { includeDeleted: true, limit: 500 });
    deletedCount = allJobs.filter((job) => job.deletedAt !== null).length;

    body =
      result.items.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {statusFilter ? '这个状态下还没有岗位。' : '还没有岗位。'}
            去 <a href="/jobs/new">粘贴一段 JD</a> 试试。
          </p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>公司</th>
                <th>岗位</th>
                <th>类别</th>
                <th>定位</th>
                <th>城市</th>
                <th>状态</th>
                <th>截止</th>
                <th>优先级</th>
                <th>技能</th>
                <th>待确认</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {result.items.map((job) => {
                const countdown = deadlineCountdown(job);
                return (
                  <tr key={job.id} style={job.deletedAt ? { opacity: 0.55 } : undefined}>
                    <td>{job.company || '—'}</td>
                    <td>{job.title || '—'}</td>
                    <td>
                      <span className="badge muted">{categoryLabel(job.category)}</span>
                    </td>
                    <td>
                      <span className={`badge${job.tier === 'primary' ? ' ok' : job.tier === 'secondary' ? '' : ' muted'}`}>
                        {job.tierLabel}
                        {job.tierOverridden ? ' ✎' : ''}
                      </span>
                    </td>
                    <td>{job.cities.join(' / ') || '—'}</td>
                    <td>
                      <span className="badge">
                        {isJobStatus(job.status) ? STATUS_LABELS[job.status] : job.status}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${countdown.tone === 'muted' ? '' : countdown.tone}`}>{countdown.label}</span>
                    </td>
                    <td>{job.priority}</td>
                    <td className="small">{job.skills.slice(0, 5).join('; ') || '—'}</td>
                    <td>
                      {job.reviewFlags.length > 0 ? (
                        <span className="badge warn">{job.reviewFlags.length}</span>
                      ) : (
                        <span className="badge ok">已齐</span>
                      )}
                    </td>
                    <td>
                      <JobRowActions jobId={job.id} deleted={job.deletedAt !== null} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    body = (
      <div className="card">
        <div className="banner danger">
          <b>无法读取数据库：</b>
          {message}
        </div>
        <p className="muted small">
          排查：① 启动数据层 <code>npm run setup</code>；② 安装数据库驱动 <code>npm install pg</code>；
          ③ 检查 <code>.env</code> 的 <code>DATABASE_URL</code>；④ 跑 <code>npm run doctor</code>。
        </p>
      </div>
    );
  }

  return (
    <main className="container wide">
      <div className="page-header">
        <h1>岗位列表</h1>
        <div className="row">
          <a className="small" href="/jobs/board">
            投递看板
          </a>
          <a className="small" href="/jobs/new">
            + 粘贴 JD
          </a>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {FILTERS.map((item) => (
          <a
            key={item.value}
            className={`badge${statusFilter === item.value ? '' : ' muted'}`}
            href={item.value ? `/jobs?status=${item.value}` : '/jobs'}
            style={{ textDecoration: 'none' }}
          >
            {item.label}
          </a>
        ))}
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        <span className="muted small">分类：</span>
        <a className={`badge${categoryFilter === '' ? '' : ' muted'}`} href="/jobs" style={{ textDecoration: 'none' }}>
          全部
        </a>
        {JOB_CATEGORIES.map((item) => (
          <a
            key={item.code}
            className={`badge${categoryFilter === item.code ? '' : ' muted'}`}
            href={`/jobs?category=${item.code}${statusFilter ? '&status=' + statusFilter : ''}`}
            style={{ textDecoration: 'none' }}
          >
            {item.label}
          </a>
        ))}
        {(['primary', 'secondary', 'casual'] as const).map((tier) => (
          <a
            key={tier}
            className={`badge${tierFilter === tier ? '' : ' muted'}`}
            href={`/jobs?tier=${tier}`}
            style={{ textDecoration: 'none' }}
          >
            {tier === 'primary' ? '主投' : tier === 'secondary' ? '副投' : '碰运气'}
          </a>
        ))}
        <a
          className="secondary small"
          href={`/jobs?deleted=${includeDeleted ? '0' : '1'}`}
          style={{ textDecoration: 'none', marginLeft: 'auto' }}
        >
          {includeDeleted ? '隐藏已删除' : '显示已删除'}
          {deletedCount > 0 ? `（${deletedCount}）` : ''}
        </a>
      </div>

      {body}
    </main>
  );
}
