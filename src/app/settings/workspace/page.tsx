import type { Metadata } from 'next';

import WorkspacePanel from './WorkspacePanel';

export const metadata: Metadata = { title: '工作区台账 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

export default function WorkspaceSettingsPage() {
  return (
    <main className="container">
      <div className="page-header">
        <h1>工作区台账</h1>
        <div className="row">
          <a className="small" href="/jobs">
            岗位列表
          </a>
          <a className="small" href="/">
            返回首页
          </a>
        </div>
      </div>
      <WorkspacePanel />
    </main>
  );
}
