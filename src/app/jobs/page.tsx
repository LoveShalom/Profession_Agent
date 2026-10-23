/**
 * 岗位列表（F-02 最小版）
 *
 * 说明：完整的筛选/排序/搜索是 I2 的 T11（4h，已从 I1 外移）。
 * 这里只做"入库后能看到"的最小视图，用来验证闭环；不要在此堆功能。
 */

import type { Metadata } from 'next';

import { getJobRepository } from '@/lib/db/factory.ts';
import { listJobs } from '@/lib/jobs/service.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const metadata: Metadata = { title: '岗位列表 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

function deadlineText(job: { deadlineKind: string; deadline: string | null }): string {
  if (job.deadlineKind === 'provided' && job.deadline) return job.deadline.slice(0, 10);
  if (job.deadlineKind === 'text_only') return '未注明';
  return '—';
}

export default async function JobsPage() {
  let body: React.ReactNode;

  try {
    const env = getEnv();
    const tenant = resolveTenant(env);
    const repo = await getJobRepository();
    const result = await listJobs(repo, tenant.userId, { limit: 100 });

    body =
      result.items.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            还没有岗位。先去 <a href="/jobs/new">粘贴一段 JD</a> 试试。
          </p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>公司</th>
                <th>岗位</th>
                <th>城市</th>
                <th>状态</th>
                <th>截止</th>
                <th>技能</th>
                <th>待确认</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((job) => (
                <tr key={job.id}>
                  <td>{job.company}</td>
                  <td>{job.title}</td>
                  <td>{job.cities.join(' / ') || '—'}</td>
                  <td>
                    <span className="badge">{job.status}</span>
                  </td>
                  <td>{deadlineText(job)}</td>
                  <td className="small">{job.skills.slice(0, 6).join('; ') || '—'}</td>
                  <td>
                    {job.reviewFlags.length > 0 ? (
                      <span className="badge warn">{job.reviewFlags.length}</span>
                    ) : (
                      <span className="badge ok">已齐</span>
                    )}
                  </td>
                </tr>
              ))}
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
    <main className="container">
      <div className="page-header">
        <h1>岗位列表</h1>
        <div className="row">
          <a className="small" href="/jobs/new">
            + 粘贴 JD
          </a>
          <a className="small" href="/">
            返回首页
          </a>
        </div>
      </div>
      {body}
      <p className="muted small">
        注：完整的筛选/排序/搜索属于 I2 的 F2 任务；本页只用于验证「入库后能看到」。
      </p>
    </main>
  );
}
