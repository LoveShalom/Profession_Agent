/**
 * 诊断页（F-09 / I4 T8）
 *
 * 回答三个问题：
 *   1. 我配的是哪套模型（文本/视觉、是否来自设置页凭证）
 *   2. 最近调用花了多少 token / 多慢 / 有没有降级
 *   3. 当前 prompt 版本是什么（改了 prompt 后版本会变）
 */

import type { Metadata } from 'next';

import { getEnv } from '@/lib/server/env.ts';
import { getModelRouter } from '@/lib/server/models.ts';
import { listRecentUsage, promptVersionOf, usageSummary } from '@/lib/server/usage.ts';
import { resolveTenant } from '@/lib/tenant.ts';

export const metadata: Metadata = { title: '诊断 · Profession Search Agent' };
export const dynamic = 'force-dynamic';

function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value);
}

export default async function DiagnosticsPage() {
  const env = getEnv();
  const userId = resolveTenant(env).userId;

  let textInfo = '未配置';
  let visionInfo = '未配置';
  let routerError: string | null = null;
  try {
    const router = await getModelRouter();
    textInfo = `${router.info.text.provider} / ${router.info.text.model}${router.text.hasCredential ? '' : '（无 Key，规则模式）'}`;
    visionInfo = router.vision
      ? `${router.info.vision.provider} / ${router.info.vision.model}${router.vision.hasCredential ? '' : '（无 Key）'}`
      : '未配置';
  } catch (error) {
    routerError = error instanceof Error ? error.message : String(error);
  }

  const [recent, summary] = await Promise.all([listRecentUsage(userId, 20), usageSummary(userId)]);

  return (
    <main className="container">
      <div className="page-header">
        <h1>诊断</h1>
        <div className="row">
          <a className="small" href="/settings/llm">
            模型设置
          </a>
          <a className="small" href="/settings/workspace">
            工作区台账
          </a>
        </div>
      </div>

      {routerError ? <div className="banner danger">读取模型配置失败：{routerError}</div> : null}

      <div className="card">
        <h2>当前模型</h2>
        <div className="field-grid">
          <div className="field">
            <label>文本模型</label>
            <div className="value small">{textInfo}</div>
          </div>
          <div className="field">
            <label>视觉模型</label>
            <div className="value small">{visionInfo}</div>
          </div>
          <div className="field">
            <label>prompt 版本（extract-jd）</label>
            <div className="value small">{promptVersionOf('extract') ?? '—'}</div>
          </div>
          <div className="field">
            <label>prompt 版本（OCR）</label>
            <div className="value small">{promptVersionOf('ocr') ?? '—'}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>最近 30 天用量</h2>
        {summary === null ? (
          <p className="muted small" style={{ margin: 0 }}>
            还没有用量数据（表未迁移、或还没发生真实模型调用）。规则模式（L4）不产生用量。
          </p>
        ) : (
          <div className="field-grid">
            <div className="field">
              <label>调用次数</label>
              <div className="value small">{fmt(summary.total)}</div>
            </div>
            <div className="field">
              <label>降级比例</label>
              <div className="value small">{(summary.degradedRate * 100).toFixed(1)}%</div>
            </div>
            <div className="field">
              <label>prompt / completion tokens</label>
              <div className="value small">
                {fmt(summary.promptTokens)} / {fmt(summary.completionTokens)}
              </div>
            </div>
            <div className="field">
              <label>平均延迟</label>
              <div className="value small">{fmt(summary.avgLatencyMs)} ms</div>
            </div>
            <div className="field">
              <label>当月成本（估算）</label>
              <div className="value small">{summary.monthCost === null ? '未记录' : `¥${summary.monthCost.toFixed(3)}`}</div>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>最近调用（{recent.length}）</h2>
        {recent.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            暂无记录。
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>provider / model</th>
                <th>task</th>
                <th>tokens</th>
                <th>延迟</th>
                <th>降级</th>
                <th>prompt 版本</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row, index) => (
                <tr key={String(row['id'] ?? index)}>
                  <td className="small">{String(row['created_at'] ?? '').slice(0, 19).replace('T', ' ')}</td>
                  <td className="small">
                    {String(row['provider'] ?? '')} / {String(row['model'] ?? '')}
                  </td>
                  <td className="small">{String(row['task'] ?? '')}</td>
                  <td className="small">
                    {Number(row['prompt_tokens'] ?? 0)} / {Number(row['completion_tokens'] ?? 0)}
                  </td>
                  <td className="small">{Number(row['latency_ms'] ?? 0)} ms</td>
                  <td className="small">{row['degraded'] ? '是' : '否'}</td>
                  <td className="small">{row['prompt_version'] === null ? '—' : String(row['prompt_version'])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted small">
        日志只记录 provider/model/task/tokens/耗时/降级/prompt 版本，**不记录 prompt 内容与密钥**。
      </p>
    </main>
  );
}
