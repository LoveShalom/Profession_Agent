import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Profession Search Agent',
  description: '本地优先的 AI 求职副驾驶：岗位库 + 经历库，数据只在你自己的机器上',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="site-nav">
          <a className="site-brand" href="/">
            Profession Search Agent
          </a>
          <nav>
            <a href="/jobs/new">粘贴 JD</a>
            <a href="/jobs">岗位列表</a>
            <a href="/experiences">经历库</a>
            <a href="/experiences/import">导入简历</a>
            <a href="/settings/workspace">工作区台账</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
