/**
 * 投递看板页（F-08 / I3 T5）
 *
 * 服务端只负责渲染壳；数据由客户端 `BoardPanel` 拉取（需要乐观更新与拖拽交互）。
 */

import type { Metadata } from 'next';

import BoardPanel from './BoardPanel.tsx';

export const metadata: Metadata = { title: '投递看板 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

export default function BoardPage() {
  return (
    <main className="container wide">
      <div className="page-header">
        <h1>投递看板</h1>
        <div className="row">
          <a className="small" href="/jobs">
            列表视图
          </a>
          <a className="small" href="/jobs/new">
            + 粘贴 JD
          </a>
        </div>
      </div>
      <BoardPanel />
    </main>
  );
}
