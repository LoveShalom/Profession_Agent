import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { statSync } from 'node:fs';

import './globals.css';

// 页脚要显示"当前构建时间"，必须在请求时读取 .next/BUILD_ID（不能被静态化）
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Profession Search Agent',
  description: '本地优先的 AI 求职副驾驶：岗位库 + 经历库，数据只在你自己的机器上',
};

/** 构建时间戳：解决"改了代码但页面没变化"的排障问题（用户能一眼看出是不是旧构建） */
function buildStamp(): string {
  try {
    return statSync('.next/BUILD_ID').mtime.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return 'dev（热更新）';
  }
}

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
            <a href="/jobs/board">投递看板</a>
            <a href="/experiences">经历库</a>
            <a href="/experiences/import">导入简历</a>
            <a href="/settings/workspace">工作区台账</a>
            <a href="/settings/diagnostics">诊断</a>
          </nav>
        </header>
        {children}
        <footer className="site-footer muted small">
          构建于 {buildStamp()} · 数据只在本机
        </footer>
      </body>
    </html>
  );
}
