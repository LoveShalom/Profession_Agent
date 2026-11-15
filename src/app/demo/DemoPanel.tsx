'use client';

/**
 * 演示页（F-09 / I4 T6）
 *
 * 硬约束：**只读**。数据来自静态样例 `evals/demo/sample.json`，不连数据库、不调写接口。
 * 用途：给评审者/招聘方一个"打开就能看"的入口，不需要注册、不会写入任何数据。
 */

import { useMemo, useState } from 'react';

import { BOARD_COLUMNS, STATUS_LABELS, TERMINAL_STATUSES } from '@/lib/status.ts';

export interface DemoJob {
  company: string;
  title: string;
  cities: string[];
  status: string;
  priority: string;
  deadline: string | null;
  deadlineKind: string;
  skills: string[];
}

export interface DemoExperience {
  type: string;
  org: string;
  role: string | null;
  period: string;
  star: { situation: string; task: string; action: string; result: string };
  skills: string[];
}

export interface DemoSample {
  note: string;
  jobs: DemoJob[];
  experiences: DemoExperience[];
}

const TYPE_LABEL: Record<string, string> = {
  internship: '实习',
  project: '项目',
  research: '科研',
  club: '社团',
};

function countdown(job: DemoJob): string {
  if (job.deadlineKind === 'text_only') return '见原文';
  if (job.deadlineKind !== 'provided' || !job.deadline) return '未提供';
  const days = Math.round(
    (Date.parse(`${job.deadline.slice(0, 10)}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) /
      (24 * 60 * 60 * 1000),
  );
  if (days < 0) return `已过期`;
  if (days === 0) return '今天截止';
  return `T-${days} 天`;
}

export default function DemoPanel({ sample }: { sample: DemoSample }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, DemoJob[]>();
    for (const status of BOARD_COLUMNS) map.set(status, []);
    const terminal: DemoJob[] = [];
    for (const job of sample.jobs) {
      if (TERMINAL_STATUSES.includes(job.status as (typeof TERMINAL_STATUSES)[number])) terminal.push(job);
      else map.get(job.status)?.push(job);
    }
    return { map, terminal };
  }, [sample.jobs]);

  return (
    <>
      <div className="banner" style={{ marginBottom: 12 }}>
        🎬 <b>演示模式（只读）</b>：这是预生成样例，不连数据库、不写任何数据。
        {sample.note ? <span className="muted small">（{sample.note}）</span> : null}
      </div>

      <div className="card">
        <h2>投递看板（示例）</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          真实产品里这些卡片可以拖拽或按 ←/→ 改状态；演示页不可交互。
        </p>
        <div className="board">
          {BOARD_COLUMNS.map((status) => (
            <div key={status} className="board-column">
              <div className="board-column-head">
                <span>{STATUS_LABELS[status]}</span>
                <span className="muted small">{grouped.map.get(status)?.length ?? 0}</span>
              </div>
              <div className="board-cards">
                {(grouped.map.get(status) ?? []).length === 0 ? <div className="board-empty">空</div> : null}
                {(grouped.map.get(status) ?? []).map((job) => (
                  <div key={`${job.company}-${job.title}`} className="board-card" style={{ cursor: 'default' }}>
                    <div className="board-card-title">{job.company}</div>
                    <div className="muted small">{job.title}</div>
                    <div className="board-card-meta">
                      <span className="badge">{job.priority}</span>
                      <span className="badge muted">{countdown(job)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {grouped.terminal.length > 0 ? (
          <details className="board-terminal">
            <summary>已结束（{grouped.terminal.length}）</summary>
            <div className="board-terminal-cards">
              {grouped.terminal.map((job) => (
                <div key={`${job.company}-${job.title}`} className="board-card" style={{ cursor: 'default' }}>
                  <div className="board-card-title">{job.company}</div>
                  <div className="muted small">
                    {job.title} · {STATUS_LABELS[job.status as (typeof BOARD_COLUMNS)[number]] ?? job.status}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      <div className="card">
        <h2>经历库（示例）</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sample.experiences.map((item, index) => (
            <div key={`${item.org}-${item.role ?? ''}`} style={{ border: '1px solid #e3e6ea', borderRadius: 8, padding: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>
                  {item.org}
                  {item.role ? ` · ${item.role}` : ''}
                </b>
                <span className="muted small">
                  {TYPE_LABEL[item.type] ?? item.type} · {item.period}
                </span>
              </div>
              <div className="chips" style={{ marginTop: 6 }}>
                {item.skills.map((skill) => (
                  <span key={skill} className="chip explicit">
                    {skill}
                  </span>
                ))}
              </div>
              <button
                type="button"
                className="secondary small"
                style={{ marginTop: 8 }}
                onClick={() => setExpanded(expanded === index ? null : index)}
              >
                {expanded === index ? '收起 STAR' : '查看 STAR'}
              </button>
              {expanded === index ? (
                <div style={{ marginTop: 8 }}>
                  {(
                    [
                      ['S 情境', item.star.situation],
                      ['T 任务', item.star.task],
                      ['A 行动', item.star.action],
                      ['R 结果', item.star.result],
                    ] as Array<[string, string]>
                  ).map(([label, value]) => (
                    <div key={label} className="field" style={{ marginTop: 6 }}>
                      <label>{label}</label>
                      <div className="value small" style={{ whiteSpace: 'pre-wrap' }}>
                        {value || '—'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
