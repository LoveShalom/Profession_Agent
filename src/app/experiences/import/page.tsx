import type { Metadata } from 'next';

import ResumeImportPanel from './ResumeImportPanel';

export const metadata: Metadata = { title: '导入简历 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

export default function ResumeImportPage() {
  return (
    <main className="container">
      <div className="page-header">
        <h1>导入简历</h1>
        <a className="small" href="/experiences">
          返回经历库
        </a>
      </div>
      <ResumeImportPanel />
    </main>
  );
}
