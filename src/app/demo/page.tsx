/**
 * 只读演示页（F-09 / I4 T6）
 *
 * 数据来自仓库内的静态样例（不连数据库、不需要 Key），
 * 方便评审者/招聘方"打开就能看"，不需要注册也不会写入任何数据。
 */

import type { Metadata } from 'next';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import DemoPanel, { type DemoSample } from './DemoPanel.tsx';

export const metadata: Metadata = { title: '演示（只读） · Profession Search Agent' };
export const dynamic = 'force-dynamic';

function loadSample(): DemoSample {
  const raw = readFileSync(path.resolve(process.cwd(), 'evals/demo/sample.json'), 'utf8');
  return JSON.parse(raw) as DemoSample;
}

export default function DemoPage() {
  let sample: DemoSample | null = null;
  let error: string | null = null;
  try {
    sample = loadSample();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return (
    <main className="container wide">
      <div className="page-header">
        <h1>演示（只读）</h1>
        <div className="row">
          <a className="small" href="/">
            首页
          </a>
          <a className="small" href="/jobs/board">
            真实看板
          </a>
        </div>
      </div>
      {error ? (
        <div className="card">
          <div className="banner danger">
            <b>样例数据缺失：</b>
            {error}
          </div>
        </div>
      ) : sample ? (
        <DemoPanel sample={sample} />
      ) : null}
    </main>
  );
}
