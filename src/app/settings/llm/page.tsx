import type { Metadata } from 'next';

import CredentialsPanel from './CredentialsPanel';

export const metadata: Metadata = { title: '模型设置 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

export default function LlmSettingsPage() {
  return (
    <main className="container">
      <div className="page-header">
        <h1>模型设置</h1>
        <a className="small" href="/">
          返回首页
        </a>
      </div>
      <CredentialsPanel />
    </main>
  );
}
