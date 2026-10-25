'use client';

import { Fragment, useEffect, useRef, useState } from 'react';

interface Candidate {
  dedupeKey: string;
  rawText: string;
  extraction: {
    type: 'internship' | 'project' | 'research' | 'club';
    org: string;
    role: string | null;
    startDate: string | null;
    endDate: string | null;
    summary: string;
    star: { situation: string; task: string; action: string; result: string };
    skills: string[];
    metrics: Array<{ metric: string; value: number; unit: string; raw: string }>;
    confidence: number;
  };
}

const TYPE_LABEL: Record<Candidate['extraction']['type'], string> = {
  internship: '实习',
  project: '项目',
  research: '科研',
  club: '社团',
};

/** 日期归一：`2024.6` / `2024/6` / `2024年6月` / `2024-06-01` → `2024-06`；认不出返回 null */
function toMonth(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const match = /^(\d{4})\s*[.\-/年]\s*(\d{1,2})/.exec(text);
  if (!match) return null;
  const month = Number(match[2]);
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}`;
}

export default function ResumeImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string; hint?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [imported, setImported] = useState(0);
  /** 展开查看候选的 STAR 全文（列表只显示摘要） */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  /** 经历库已有条数：用于告诉用户"导入后会去哪里看" */
  const [existingCount, setExistingCount] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/experiences', { cache: 'no-store' });
        const data = (await response.json()) as { total?: number };
        setExistingCount(typeof data.total === 'number' ? data.total : null);
      } catch {
        setExistingCount(null);
      }
    })();
  }, [imported]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setNote(null);
    setCandidates([]);
    setImported(0);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      const response = await fetch('/api/resume/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, mime: file.type, dataBase64: base64 }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        candidates?: Candidate[];
        warnings?: string[];
        format?: string;
        code?: string;
        message?: string;
        hint?: string;
      };
      if (!data.ok) {
        setError({ code: data.code, message: data.message ?? '导入失败', ...(data.hint ? { hint: data.hint } : {}) });
        return;
      }
      const list = data.candidates ?? [];
      setCandidates(list);
      setSelected(Object.fromEntries(list.map((item) => [item.dedupeKey, true])));
      setNote(
        `识别到 ${list.length} 段候选经历（${data.format ?? ''}）${(data.warnings ?? []).length > 0 ? `；${(data.warnings ?? []).join('；')}` : ''}。请逐条核对后再导入。`,
      );
    } catch (caught) {
      setError({ message: caught instanceof Error ? caught.message : '网络错误' });
    } finally {
      setBusy(false);
    }
  }

  function updateCandidate(key: string, patchValue: Partial<Candidate['extraction']>) {
    setCandidates((previous) =>
      previous.map((item) =>
        item.dedupeKey === key ? { ...item, extraction: { ...item.extraction, ...patchValue } } : item,
      ),
    );
  }

  function updateRawText(key: string, rawText: string) {
    setCandidates((previous) => previous.map((item) => (item.dedupeKey === key ? { ...item, rawText } : item)));
  }

  async function importSelected() {
    setBusy(true);
    setError(null);
    let count = 0;
    const failures: string[] = [];
    try {
      for (const candidate of candidates) {
        if (!selected[candidate.dedupeKey]) continue;
        const { extraction } = candidate;
        const response = await fetch('/api/experiences', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            // 用户在导入页勾选 = 明确要这几条，因此跳过"重复"拦截
            forceCreate: true,
            form: {
              type: extraction.type,
              org: (extraction.org || candidate.rawText.split('\n')[0] || '未命名经历').slice(0, 120),
              role: extraction.role && extraction.role.trim().length > 0 ? extraction.role.slice(0, 120) : null,
              startDate: toMonth(extraction.startDate),
              endDate: toMonth(extraction.endDate),
              summary: extraction.summary.slice(0, 1000),
              star: {
                situation: extraction.star.situation.slice(0, 2000),
                task: extraction.star.task.slice(0, 2000),
                action: extraction.star.action.slice(0, 4000),
                result: extraction.star.result.slice(0, 2000),
              },
              skills: extraction.skills.slice(0, 50).map((skill) => skill.slice(0, 40)),
              metrics: extraction.metrics.slice(0, 20),
              evidenceUrls: [],
              rawText: candidate.rawText.slice(0, 8000),
            },
          }),
        });
        const data = (await response.json()) as {
          ok?: boolean;
          status?: string;
          error?: string;
          issues?: Array<{ path: string; message: string }>;
        };
        if (data.ok) {
          if (data.status !== 'duplicate') count += 1;
        } else {
          const detail =
            data.issues && data.issues.length > 0
              ? data.issues.map((issue) => `${issue.path} ${issue.message}`).join('、')
              : (data.error ?? '未知错误');
          failures.push(`${extraction.org || '（无组织）'}：${detail}`);
        }
      }
      setImported(count);
      if (failures.length > 0) {
        setNote(`已导入 ${count} 条；${failures.length} 条失败（原因见下方红色提示）`);
        setError({ message: failures.slice(0, 3).join('；') });
      } else {
        setNote(`已导入 ${count} 条经历`);
      }
    } catch (caught) {
      setError({ message: caught instanceof Error ? caught.message : '导入失败' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>导入旧简历</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          支持 PDF（含文字层）与 DOCX，≤10MB。**只产出候选经历，不会自动入库**——识别错的内容进库比没进更糟。
        </p>
        <div className="row">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? '处理中…' : '选择简历文件'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = '';
            }}
          />
          <a className="small" href="/experiences">
            查看已有经历{existingCount !== null ? `（${existingCount} 条）` : ''} →
          </a>
        </div>

        {error ? (
          <div className="banner danger" style={{ marginTop: 12 }}>
            <b>{error.message}</b>
            {error.hint ? <div className="small" style={{ marginTop: 4 }}>{error.hint}</div> : null}
            {error.code === 'E_DEPENDENCY_MISSING' ? (
              <div className="small muted" style={{ marginTop: 4 }}>
                在项目目录运行：<code>npm install unpdf mammoth</code> 后重启服务
              </div>
            ) : null}
          </div>
        ) : null}
        {note ? <div className="banner" style={{ marginTop: 12 }}>{note}</div> : null}
      </div>

      {candidates.length > 0 ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>候选经历（{candidates.length}）</h2>
            <div className="row">
              <button type="button" className="secondary small" onClick={() => setSelected(Object.fromEntries(candidates.map((item) => [item.dedupeKey, true])))}>
                全选
              </button>
              <button type="button" onClick={() => void importSelected()} disabled={busy}>
                {busy ? '导入中…' : '导入选中'}
              </button>
            </div>
          </div>
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>选</th>
                <th>类型</th>
                <th>组织</th>
                <th>角色</th>
                <th>时间</th>
                <th>结果</th>
                <th>置信度</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => {
                const ex = candidate.extraction;
                const expanded = expandedKey === candidate.dedupeKey;
                return (
                  <Fragment key={candidate.dedupeKey}>
                    <tr>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected[candidate.dedupeKey] ?? false}
                          onChange={(event) => setSelected((previous) => ({ ...previous, [candidate.dedupeKey]: event.target.checked }))}
                        />
                      </td>
                      <td>{TYPE_LABEL[ex.type]}</td>
                      <td>{ex.org || '—'}</td>
                      <td>{ex.role ?? '—'}</td>
                      <td className="small">{[ex.startDate, ex.endDate].filter(Boolean).join(' ~ ') || '—'}</td>
                      <td className="small">{ex.star.result ? ex.star.result.slice(0, 40) : <span className="badge warn">待补</span>}</td>
                      <td>{Math.round(ex.confidence * 100)}%</td>
                      <td>
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => setExpandedKey(expanded ? null : candidate.dedupeKey)}
                        >
                          {expanded ? '收起' : '查看'}
                        </button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td colSpan={8}>
                          <div style={{ padding: '8px 0' }}>
                            <p className="muted small" style={{ margin: '0 0 8px' }}>
                              以下内容可直接修改；改完再导入（不会改动简历原文件）。
                            </p>
                            <div className="field-grid">
                              <div className="field">
                                <label>组织（可空）</label>
                                <input style={{ width: '100%' }} value={ex.org} onChange={(event) => updateCandidate(candidate.dedupeKey, { org: event.target.value })} />
                              </div>
                              <div className="field">
                                <label>角色</label>
                                <input style={{ width: '100%' }} value={ex.role ?? ''} onChange={(event) => updateCandidate(candidate.dedupeKey, { role: event.target.value })} />
                              </div>
                              <div className="field">
                                <label>开始（YYYY-MM）</label>
                                <input style={{ width: '100%' }} value={ex.startDate ?? ''} onChange={(event) => updateCandidate(candidate.dedupeKey, { startDate: event.target.value || null })} />
                              </div>
                              <div className="field">
                                <label>结束（YYYY-MM，可空）</label>
                                <input style={{ width: '100%' }} value={ex.endDate ?? ''} onChange={(event) => updateCandidate(candidate.dedupeKey, { endDate: event.target.value || null })} />
                              </div>
                              <div className="field">
                                <label>技能（逗号分隔）</label>
                                <input
                                  style={{ width: '100%' }}
                                  value={ex.skills.join(', ')}
                                  onChange={(event) =>
                                    updateCandidate(candidate.dedupeKey, {
                                      skills: event.target.value.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean),
                                    })
                                  }
                                />
                              </div>
                              <div className="field">
                                <label>摘要</label>
                                <input style={{ width: '100%' }} value={ex.summary} onChange={(event) => updateCandidate(candidate.dedupeKey, { summary: event.target.value })} />
                              </div>
                            </div>
                            {(['situation', 'task', 'action', 'result'] as const).map((field) => (
                              <div key={field} className="field" style={{ marginTop: 8 }}>
                                <label>{{ situation: 'S 情境', task: 'T 任务', action: 'A 行动', result: 'R 结果' }[field]}</label>
                                <textarea
                                  style={{ minHeight: 64, width: '100%' }}
                                  value={ex.star[field]}
                                  onChange={(event) =>
                                    updateCandidate(candidate.dedupeKey, { star: { ...ex.star, [field]: event.target.value } })
                                  }
                                />
                              </div>
                            ))}
                            <div style={{ marginTop: 8 }}>
                              <label className="muted small">简历原文片段（可编辑）</label>
                              <textarea
                                style={{ minHeight: 90, width: '100%', fontFamily: 'ui-monospace, Consolas, monospace' }}
                                value={candidate.rawText}
                                onChange={(event) => updateRawText(candidate.dedupeKey, event.target.value)}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {imported > 0 ? (
            <div className="banner" style={{ marginTop: 12 }}>
              ✅ 已导入 <b>{imported}</b> 条到经历库。
              <div className="row" style={{ marginTop: 8 }}>
                <a className="small" href="/experiences">
                  去经历库查看 / 编辑 →
                </a>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
