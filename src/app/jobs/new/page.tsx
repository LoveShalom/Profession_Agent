import type { Metadata } from 'next';

import PasteForm from './PasteForm';

export const metadata: Metadata = { title: '粘贴 JD · Profession Search Agent' };
export const dynamic = 'force-dynamic';

export default function NewJobPage() {
  return (
    <main className="container">
      <div className="page-header">
        <h1>粘贴 JD</h1>
        <a className="small" href="/">
          ← 返回首页
        </a>
      </div>
      <PasteForm />
    </main>
  );
}
