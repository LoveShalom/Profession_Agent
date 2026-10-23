import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="container">
      <div className="page-header">
        <h1>Profession Search Agent</h1>
        <span className="badge">本地优先 · 数据不出机器</span>
      </div>

      <div className="card">
        <h2>从一段 JD 开始</h2>
        <p className="muted">
          粘贴招聘 JD，系统会抽取 18 个字段（公司 / 岗位 / 城市 / 薪资 / 截止时间 / 技能属性…），
          并对每个字段给出<b>原文依据</b>与<b>置信度</b>。确认后入库。
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <Link href="/jobs/new">
            <button type="button">粘贴 JD 并解析</button>
          </Link>
          <Link href="/jobs">
            <button type="button" className="secondary">
              查看岗位列表
            </button>
          </Link>
        </div>
      </div>

      <div className="card">
        <h2>工作方式</h2>
        <ul className="muted" style={{ margin: 0, paddingLeft: 20 }}>
          <li>不配置模型也能用：自动走<b>规则模式</b>，字段会标记「待确认」，由你逐项核对。</li>
          <li>配置了模型（BYOK）：走 tool calling / Prompt-JSON 抽取，失败自动降级，不会白屏。</li>
          <li>截止日期是<b>可选</b>的：JD 没写就记为「未提供」，不会编造日期、也不会阻塞入库。</li>
          <li>技能分三类显示：<b>明确(必须)</b> / <b>明确(加分)</b> / <b>推测</b>，推测项都带原文依据。</li>
        </ul>
      </div>
    </main>
  );
}
