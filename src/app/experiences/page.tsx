import type { Metadata } from 'next';

import ExperiencesPanel from './ExperiencesPanel';

export const metadata: Metadata = { title: '经历库 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

export default function ExperiencesPage() {
  return (
    <main className="container">
      <div className="page-header">
        <h1>经历库</h1>
        <div className="row">
          <a className="small" href="/experiences/import">
            导入简历
          </a>
          <a className="small" href="/jobs">
            岗位列表
          </a>
          <a className="small" href="/">
            返回首页
          </a>
        </div>
      </div>
      <ExperiencesPanel />
    </main>
  );
}
