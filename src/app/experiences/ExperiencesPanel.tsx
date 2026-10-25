'use client';

import { useCallback, useEffect, useState } from 'react';

type ExperienceType = 'internship' | 'project' | 'research' | 'club';

const TYPE_LABEL: Record<ExperienceType, string> = {
  internship: '实习',
  project: '项目',
  research: '科研',
  club: '社团',
};

interface ListItem {
  id: string;
  type: ExperienceType;
  org: string;
  role: string | null;
  startDate: string | null;
  resumeReady: boolean;
  skills: string[];
  deletedAt: string | null;
}

interface FormState {
  type: ExperienceType;
  org: string;
  role: string;
  startDate: string;
  endDate: string;
  summary: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  skills: string;
}

const EMPTY_FORM: FormState = {
  type: 'project',
  org: '',
  role: '',
  startDate: '',
  endDate: '',
  summary: '',
  situation: '',
  task: '',
  action: '',
  result: '',
  skills: '',
};

export default function ExperiencesPanel() {
  const [items, setItems] = useState<ListItem[]>([]);
  /** 展开查看的那条经历（列表只显示摘要，全文在这里看） */
  const [detail, setDetail] = useState<(ListItem & {
    endDate: string | null;
    summary: string;
    star: { situation: string; task: string; action: string; result: string };
    metrics: Array<{ metric: string; value: number; unit: string; raw: string }>;
    rawText: string;
    updatedAt: string;
  }) | null>(null);
  const [resumeReady, setResumeReady] = useState(0);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [typeFilter, setTypeFilter] = useState<'all' | ExperienceType>('all');
  const [mode, setMode] = useState<'manual' | 'text'>('manual');
  const [rawText, setRawText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  /** 量化指标：AI 草稿带过来的指标必须原样保存，否则会丢失 */
  const [draftMetrics, setDraftMetrics] = useState<Array<{ metric: string; value: number; unit: string; raw: string }>>([]);
  /** 非空表示在编辑已有经历（PATCH），否则是新建（POST） */
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (includeDeleted) query.set('includeDeleted', '1');
      if (typeFilter !== 'all') query.set('type', typeFilter);
      const response = await fetch(`/api/experiences${query.size > 0 ? '?' + query.toString() : ''}`, { cache: 'no-store' });
      const data = (await response.json()) as { total?: number; resumeReady?: number; items?: ListItem[]; error?: string };
      if (data.error) {
        setError(data.error);
        return;
      }
      setItems(data.items ?? []);
      setResumeReady(data.resumeReady ?? 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    }
  }, [includeDeleted, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (key: keyof FormState, value: string) => setForm((previous) => ({ ...previous, [key]: value }));

  async function draftFromText() {
    setDrafting(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch('/api/experiences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rawText }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        error?: string;
        extraction?: {
          type: ExperienceType;
          org: string;
          role: string | null;
          startDate: string | null;
          endDate: string | null;
          summary: string;
          star: { situation: string; task: string; action: string; result: string };
          skills: string[];
          metrics?: Array<{ metric: string; value: number; unit: string; raw: string }>;
          confidence: number;
        };
        resumeReady?: boolean;
        engine?: 'llm' | 'rules';
        level?: string | null;
        banner?: string;
        warnings?: string[];
      };
      if (!data.ok || !data.extraction) {
        setError(data.error ?? '生成草稿失败');
        return;
      }
      const extraction = data.extraction;
      setForm({
        type: extraction.type,
        org: extraction.org,
        role: extraction.role ?? '',
        startDate: extraction.startDate ?? '',
        endDate: extraction.endDate ?? '',
        summary: extraction.summary,
        situation: extraction.star.situation,
        task: extraction.star.task,
        action: extraction.star.action,
        result: extraction.star.result,
        skills: extraction.skills.join(', '),
      });
      setDraftMetrics(extraction.metrics ?? []);
      setMode('manual');
      const engineLabel = data.engine === 'llm' ? `AI 归纳${data.level ? '(' + data.level + ')' : ''}` : '规则切分';
      setNote(
        `${engineLabel}：置信度 ${Math.round(extraction.confidence * 100)}%${data.resumeReady ? '' : '；行动/结果还空着，建议补全后再保存'}。${data.banner ?? ''}请核对后保存。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setDrafting(false);
    }
  }

  async function save(forceCreate = false) {
    setSaving(true);
    setError(null);
    setNote(null);
    setDuplicateId(null);
    try {
      const endpoint = editingId ? `/api/experiences/${editingId}` : '/api/experiences';
      const method = editingId ? 'PATCH' : 'POST';
      const response = await fetch(endpoint, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(editingId ? {} : { forceCreate }),
          form: {
            type: form.type,
            org: form.org,
            role: form.role.trim().length > 0 ? form.role : null,
            startDate: form.startDate.trim().length > 0 ? form.startDate : null,
            endDate: form.endDate.trim().length > 0 ? form.endDate : null,
            summary: form.summary,
            star: { situation: form.situation, task: form.task, action: form.action, result: form.result },
            skills: form.skills
              .split(/[,，;；\s]+/)
              .map((item) => item.trim())
              .filter((item) => item.length > 0),
            metrics: draftMetrics,
            evidenceUrls: [],
            rawText,
          },
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        status?: string;
        error?: string;
        issues?: Array<{ path: string; message: string }>;
        duplicateOf?: { id: string; org: string };
      };
      if (!data.ok) {
        setError(
          data.issues && data.issues.length > 0
            ? `字段不合法：${data.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`
            : (data.error ?? '保存失败'),
        );
        return;
      }
      if (data.status === 'duplicate') {
        setDuplicateId(data.duplicateOf?.id ?? null);
        setNote(`该经历已存在（${data.duplicateOf?.org ?? ''}），可用下方按钮强制新建`);
        return;
      }
      setNote(editingId ? '修改已保存' : '已保存到经历库');
      setForm(EMPTY_FORM);
      setDraftMetrics([]);
      setRawText('');
      setEditingId(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(id: string) {
    try {
      const response = await fetch(`/api/experiences/${id}`, { cache: 'no-store' });
      const data = (await response.json()) as { ok?: boolean; experience?: typeof detail; error?: string };
      if (!data.ok || !data.experience) {
        setError(data.error ?? '读取详情失败');
        return;
      }
      setDetail(data.experience);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    }
  }

  function startEdit(item: NonNullable<typeof detail>) {
    setForm({
      type: item.type,
      org: item.org,
      role: item.role ?? '',
      startDate: item.startDate ?? '',
      endDate: item.endDate ?? '',
      summary: item.summary,
      situation: item.star.situation,
      task: item.star.task,
      action: item.star.action,
      result: item.star.result,
      skills: item.skills.join(', '),
    });
    setDraftMetrics(item.metrics ?? []);
    setRawText(item.rawText ?? '');
    setEditingId(item.id);
    setDetail(null);
    setNote('正在编辑已有经历：修改后点「保存修改」');
  }

  async function remove(id: string) {
    await fetch(`/api/experiences/${id}`, { method: 'DELETE' });
    await load();
  }

  async function restore(id: string) {
    await fetch(`/api/experiences/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restore: true }),
    });
    await load();
  }

  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>经历库</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              共 {items.filter((item) => !item.deletedAt).length} 条，其中 <b>{resumeReady}</b> 条可直接用于生成简历（行动 + 结果齐全）
            </p>
          </div>
          <div className="row">
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | ExperienceType)} aria-label="按类型筛选">
              <option value="all">全部类型</option>
              {(Object.keys(TYPE_LABEL) as ExperienceType[]).map((value) => (
                <option key={value} value={value}>
                  {TYPE_LABEL[value]}
                </option>
              ))}
            </select>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)} />
              显示已删除
            </label>
          </div>
        </div>

        {items.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>
            还没有经历。用下面的表单加一条，或者粘贴一段自述让系统生成 STAR 草稿。
          </p>
        ) : (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>类型</th>
                <th>组织</th>
                <th>角色</th>
                <th>开始</th>
                <th>技能</th>
                <th>可用于简历</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} style={item.deletedAt ? { opacity: 0.5 } : undefined}>
                  <td>{TYPE_LABEL[item.type]}</td>
                  <td>{item.org || '—'}</td>
                  <td>{item.role ?? '—'}</td>
                  <td>{item.startDate ?? '—'}</td>
                  <td className="small">{item.skills.slice(0, 5).join('; ') || '—'}</td>
                  <td>{item.resumeReady ? <span className="badge ok">可用</span> : <span className="badge warn">待补</span>}</td>
                  <td>
                    <button
                      type="button"
                      className="secondary small"
                      style={{ marginRight: 6 }}
                      onClick={() => void openDetail(item.id)}
                    >
                      查看
                    </button>
                    {item.deletedAt ? (
                      <button type="button" className="secondary small" onClick={() => void restore(item.id)}>
                        恢复
                      </button>
                    ) : (
                      <button type="button" className="secondary small" onClick={() => void remove(item.id)}>
                        删除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detail ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>
              经历详情：{detail.org || '（未填组织）'}
              {detail.role ? ` · ${detail.role}` : ''}
            </h2>
            <div className="row">
              {detail.resumeReady ? (
                <span className="badge ok">可用于生成简历</span>
              ) : (
                <span className="badge warn">行动/结果待补</span>
              )}
              <button type="button" className="secondary small" onClick={() => startEdit(detail)}>
                编辑
              </button>
              <button type="button" className="secondary small" onClick={() => setDetail(null)}>
                收起
              </button>
            </div>
          </div>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            {TYPE_LABEL[detail.type]} · {[detail.startDate, detail.endDate].filter(Boolean).join(' ~ ') || '未填时间'} · 更新于{' '}
            {detail.updatedAt.slice(0, 10)}
          </p>

          <div className="field-grid" style={{ marginTop: 12 }}>
            <div className="field">
              <label>摘要</label>
              <div className="value small">{detail.summary || '—'}</div>
            </div>
            <div className="field">
              <label>技能</label>
              <div className="chips">
                {detail.skills.length === 0 ? <span className="muted small">—</span> : null}
                {detail.skills.map((skill) => (
                  <span key={skill} className="chip explicit">
                    {skill}
                  </span>
                ))}
              </div>
            </div>
            <div className="field">
              <label>量化指标</label>
              <div className="small">
                {detail.metrics.length === 0
                  ? '—'
                  : detail.metrics.map((metric) => `${metric.metric} ${metric.value}${metric.unit}`).join('；')}
              </div>
            </div>
          </div>

          {(
            [
              ['S 情境', detail.star.situation],
              ['T 任务', detail.star.task],
              ['A 行动', detail.star.action],
              ['R 结果', detail.star.result],
            ] as Array<[string, string]>
          ).map(([label, value]) => (
            <div key={label} className="field" style={{ marginTop: 8 }}>
              <label>{label}</label>
              <div className="value small" style={{ whiteSpace: 'pre-wrap' }}>
                {value || '—'}
              </div>
            </div>
          ))}

          {detail.rawText ? (
            <div style={{ marginTop: 8 }}>
              <label className="muted small">原始描述</label>
              <pre style={{ maxHeight: 220, overflow: 'auto' }}>{detail.rawText}</pre>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <h2>新增经历</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <button type="button" className={mode === 'manual' ? undefined : 'secondary'} onClick={() => setMode('manual')}>
            手动填写
          </button>
          <button type="button" className={mode === 'text' ? undefined : 'secondary'} onClick={() => setMode('text')}>
            从一段文字生成
          </button>
        </div>

        {mode === 'text' ? (
          <>
            <textarea
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
              placeholder="粘贴一段自述，例如：在某某科技有限公司实习，担任后端开发实习生，时间 2026年6月到2026年9月。背景：订单系统大促超时。任务：把 P99 降到 200ms。行动：重写查询、加 Redis 缓存、分库分表。结果：P99 从 800ms 降到 180ms。"
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" onClick={() => void draftFromText()} disabled={drafting || rawText.trim().length < 20}>
                {drafting ? '生成中…' : '生成 STAR 草稿'}
              </button>
              <span className="muted small">只生成草稿，不会直接入库；生成后可逐段修改</span>
            </div>
          </>
        ) : null}

        <div className="field-grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="e-type">类型</label>
            <select id="e-type" value={form.type} onChange={(event) => set('type', event.target.value)}>
              {Object.entries(TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="e-org">组织（公司/项目/实验室）*</label>
            <input id="e-org" style={{ width: '100%' }} value={form.org} onChange={(event) => set('org', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="e-role">角色</label>
            <input id="e-role" style={{ width: '100%' }} value={form.role} onChange={(event) => set('role', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="e-start">开始（YYYY-MM）</label>
            <input id="e-start" style={{ width: '100%' }} placeholder="2026-06" value={form.startDate} onChange={(event) => set('startDate', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="e-end">结束（YYYY-MM，可空）</label>
            <input id="e-end" style={{ width: '100%' }} placeholder="2026-09" value={form.endDate} onChange={(event) => set('endDate', event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="e-skills">技能（逗号分隔）</label>
            <input id="e-skills" style={{ width: '100%' }} value={form.skills} onChange={(event) => set('skills', event.target.value)} />
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          {(
            [
              ['summary', '摘要（一句话）'],
              ['situation', 'S 情境：当时什么背景/问题'],
              ['task', 'T 任务：你要达成什么'],
              ['action', 'A 行动：你具体做了什么'],
              ['result', 'R 结果：量化成效（没有就留空，别编）'],
            ] as Array<[keyof FormState, string]>
          ).map(([key, label]) => (
            <div key={key} style={{ marginTop: 8 }}>
              <label className="muted small" htmlFor={`e-${key}`}>
                {label}
              </label>
              <textarea
                id={`e-${key}`}
                style={{ minHeight: key === 'action' ? 90 : 60 }}
                value={form[key]}
                onChange={(event) => set(key, event.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => void save(false)} disabled={saving || form.org.trim().length === 0}>
            {saving ? '保存中…' : editingId ? '保存修改' : '保存经历'}
          </button>
          {editingId ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setEditingId(null);
                setForm(EMPTY_FORM);
                setDraftMetrics([]);
                setRawText('');
                setNote(null);
              }}
            >
              取消编辑
            </button>
          ) : null}
          {duplicateId ? (
            <button type="button" className="secondary" onClick={() => void save(true)} disabled={saving}>
              仍然新建一条
            </button>
          ) : null}
          <span className="muted small">至少填「组织」+ 摘要/行动/原文之一</span>
        </div>

        {note ? <div className="banner" style={{ marginTop: 12 }}>{note}</div> : null}
        {error ? <div className="banner danger" style={{ marginTop: 12 }}>{error}</div> : null}
      </div>
    </div>
  );
}
