'use client';

import Link from 'next/link';
import { useState } from 'react';

import ImageInput from './ImageInput';

// ---------------------------------------------------------------- 类型（与 API 契约对齐）
type SkillSource = 'explicit' | 'inferred';
type SkillRequirement = 'must' | 'nice_to_have' | 'unknown';
type SkillProficiency = 'expert' | 'proficient' | 'familiar' | 'basic' | 'unknown';
type DeadlineKind = 'provided' | 'text_only' | 'absent';

interface SkillItem {
  name: string;
  source: SkillSource;
  requirement: SkillRequirement;
  proficiency: SkillProficiency;
  confidence: number;
  basisPhrase: string;
}

interface Deadline {
  kind: DeadlineKind;
  at: string | null;
  text: string | null;
}

interface JdFields {
  company: string;
  title: string;
  cities: string[];
  job_type: string;
  graduation_year: number | null;
  work_mode: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_months: number | null;
  salary_negotiable: boolean;
  education: string;
  experience_years: unknown;
  skills: SkillItem[];
  deadline: Deadline;
  deadline_text: string | null;
  channel: string | null;
  is_referral: boolean;
  referral_code: string | null;
  source: string;
  source_url: string | null;
  raw_text: string;
}

interface ParseResponse {
  ok: boolean;
  errors: string[];
  warnings: string[];
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | null;
  degraded: boolean;
  path: string;
  banner?: string;
  consistency?: { score: number; sampleCount: number };
  extraction: {
    fields: JdFields;
    evidence: Record<string, string | null | undefined>;
    confidence: Record<string, number | undefined>;
  };
  validation: { ok: boolean; blockers: string[]; messages: string[]; needsReview: string[] };
  meta: {
    charCount: number;
    language: string;
    segmentCount: number;
    piiFlags: string[];
    injectionDetected: boolean;
    sampling: number;
    deadline: { deadline: Deadline; evidence: string | null };
  };
}

interface SaveResponse {
  status: 'created' | 'duplicate' | 'blocked';
  job?: { id: string; company: string; title: string; review_flags: string[] };
  duplicateOf?: { id: string; company: string; title: string; createdAt: string };
  blockers?: string[];
  messages?: string[];
  error?: { code: string; message: string; hint?: string };
}

const PROFICIENCY_LABEL: Record<SkillProficiency, string> = {
  expert: '精通',
  proficient: '熟练',
  familiar: '熟悉',
  basic: '了解',
  unknown: '',
};

const LEVEL_LABEL: Record<string, string> = {
  L0: 'L0 tool calling',
  L1: 'L1 Prompt-JSON',
  L2: 'L2 结构化失败',
  L3: 'L3 规则模式（降级）',
  L4: 'L4 规则模式（无 Key）',
};

function splitSkills(skills: SkillItem[]) {
  const withProficiency = (item: SkillItem) => {
    const label = PROFICIENCY_LABEL[item.proficiency];
    return label ? `${item.name}(${label})` : item.name;
  };
  return {
    explicitMust: skills.filter((s) => s.source === 'explicit' && s.requirement === 'must').map(withProficiency),
    explicitNice: skills.filter((s) => s.source === 'explicit' && s.requirement !== 'must').map(withProficiency),
    inferred: skills
      .filter((s) => s.source === 'inferred')
      .map((s) => `${s.name}(${s.confidence.toFixed(1)}←"${s.basisPhrase}")`),
  };
}

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export default function PasteForm() {
  const [inputMode, setInputMode] = useState<'text' | 'image'>('text');
  const [rawText, setRawText] = useState('');
  const [source, setSource] = useState<'manual' | 'plugin' | 'import'>('manual');
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResponse | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // 可编辑字段（用户校准）
  const [company, setCompany] = useState('');
  const [title, setTitle] = useState('');
  const [citiesText, setCitiesText] = useState('');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [deadlineKind, setDeadlineKind] = useState<DeadlineKind>('absent');
  const [deadlineText, setDeadlineText] = useState('');
  const [editedFields, setEditedFields] = useState<string[]>([]);
  /** 截图识别成功后的附件相对路径（入库时写进 jd_structured.source_image） */
  const [sourceImage, setSourceImage] = useState<string | null>(null);

  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResponse | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const markEdited = (id: string) => setEditedFields((prev) => (prev.includes(id) ? prev : [...prev, id]));

  async function handleParse(textOverride?: string) {
    const text = textOverride ?? rawText;
    setParsing(true);
    setParseError(null);
    setParseResult(null);
    setSaveResult(null);
    setSaveError(null);
    setEditedFields([]);
    setConfirmed(false);
    try {
      const response = await fetch('/api/parse-jd', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rawText: text, source }),
      });
      const data = (await response.json()) as ParseResponse & { error?: { message: string; hint?: string } };
      if (!response.ok) {
        setParseError(data.error ? `${data.error.message}${data.error.hint ? `（${data.error.hint}）` : ''}` : '解析失败');
        return;
      }
      setParseResult(data);
      const fields = data.extraction.fields;
      setCompany(fields.company);
      setTitle(fields.title);
      setCitiesText(fields.cities.join(';'));
      setSalaryMin(fields.salary_min === null ? '' : String(fields.salary_min));
      setSalaryMax(fields.salary_max === null ? '' : String(fields.salary_max));
      setDeadlineKind(fields.deadline.kind);
      setDeadlineText(fields.deadline_text ?? fields.deadline.text ?? '');
    } catch (error) {
      setParseError(error instanceof Error ? error.message : '网络错误');
    } finally {
      setParsing(false);
    }
  }

  async function handleSave(forceCreate = false) {
    if (!parseResult) return;
    setSaving(true);
    setSaveError(null);
    try {
      const base = parseResult.extraction.fields;
      const deadline: Deadline =
        deadlineKind === 'provided'
          ? { kind: 'provided', at: base.deadline.kind === 'provided' ? base.deadline.at : null, text: deadlineText || null }
          : deadlineKind === 'text_only'
            ? { kind: 'text_only', at: null, text: deadlineText.trim().length > 0 ? deadlineText.trim() : '（JD 未注明）' }
            : { kind: 'absent', at: null, text: null };

      const extraction = {
        ...parseResult.extraction,
        fields: {
          ...base,
          company: company.trim(),
          title: title.trim(),
          cities: citiesText
            .split(/[;；,，、/\s]+/)
            .map((city) => city.trim())
            .filter((city) => city.length > 0),
          salary_min: toNumberOrNull(salaryMin),
          salary_max: toNumberOrNull(salaryMax),
          salary_negotiable: toNumberOrNull(salaryMin) === null && toNumberOrNull(salaryMax) === null && base.salary_negotiable,
          deadline,
          deadline_text: deadlineKind === 'provided' ? base.deadline_text : deadline.text,
        },
      };

      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ extraction, forceCreate, confirmedFields: editedFields, sourceImage }),
      });
      const data = (await response.json()) as SaveResponse;
      if (!response.ok && data.status === undefined) {
        setSaveError(data.error ? `${data.error.code}: ${data.error.message}` : '入库失败');
        return;
      }
      setSaveResult(data);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '网络错误');
    } finally {
      setSaving(false);
    }
  }

  const needsReview = parseResult?.validation.needsReview ?? [];
  const blockers = parseResult?.validation.blockers ?? [];
  const requireConfirm = needsReview.length > 0 || blockers.length > 0;
  const canSave = parseResult !== null && (!requireConfirm || confirmed) && !saving;

  return (
    <div>
      <div className="card">
        <div className="row" style={{ marginBottom: 10, gap: 8 }}>
          <button
            type="button"
            className={inputMode === 'text' ? undefined : 'secondary'}
            onClick={() => setInputMode('text')}
          >
            粘贴文字
          </button>
          <button
            type="button"
            className={inputMode === 'image' ? undefined : 'secondary'}
            onClick={() => setInputMode('image')}
          >
            截图识别
          </button>
          <span className="muted small">招聘网站禁止复制时，用截图识别（需要支持视觉的模型）</span>
        </div>

        {inputMode === 'image' ? (
          <ImageInput
            onText={(text, meta) => {
              setRawText(text);
              setSourceImage(meta?.attachment ?? null);
              setInputMode('text');
            }}
          />
        ) : null}

        <label className="muted small" htmlFor="jd-text" style={{ display: 'block', marginTop: inputMode === 'image' ? 14 : 0 }}>
          JD 原文（从招聘网站复制粘贴即可；截图识别的结果也会填到这里）
        </label>
        <textarea
          id="jd-text"
          value={rawText}
          onChange={(event) => setRawText(event.target.value)}
          placeholder="粘贴 JD 全文…"
        />
        <div className="row" style={{ marginTop: 10 }}>
          <select value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
            <option value="manual">手动粘贴</option>
            <option value="import">文件导入</option>
            <option value="plugin">浏览器插件</option>
          </select>
          <button type="button" onClick={() => void handleParse()} disabled={parsing || rawText.trim().length === 0}>
            {parsing ? '解析中…' : '解析 JD'}
          </button>
          <span className="muted small">{rawText.trim().length} 字符</span>
        </div>
        {parseError ? <div className="banner danger" style={{ marginTop: 12 }}>{parseError}</div> : null}
      </div>

      {parseResult ? (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>解析结果</h2>
              <div className="row">
                {parseResult.level ? (
                  <span className={`badge ${parseResult.degraded ? 'warn' : 'ok'}`}>
                    {LEVEL_LABEL[parseResult.level] ?? parseResult.level}
                  </span>
                ) : (
                  <span className="badge">规则模式</span>
                )}
                <span className="badge">{parseResult.path}</span>
                {parseResult.meta.sampling > 1 ? (
                  <span className="badge">K={parseResult.meta.sampling}</span>
                ) : null}
                <span className="badge">待确认 {needsReview.length}</span>
              </div>
            </div>

            {parseResult.banner ? <div className="banner warn" style={{ marginTop: 12 }}>{parseResult.banner}</div> : null}

            {parseResult.consistency ? (
              <div className="banner" style={{ marginTop: 12 }}>
                自一致性：{parseResult.consistency.sampleCount} 次采样，平均一致率{' '}
                <b>{(parseResult.consistency.score * 100).toFixed(1)}%</b>（一致率已替代模型自报置信度）
              </div>
            ) : null}

            {blockers.length > 0 ? (
              <div className="banner danger" style={{ marginTop: 12 }}>
                <b>入库受阻：</b>
                <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                  {parseResult.validation.messages.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="muted small" style={{ marginTop: 12 }}>
              字数 {parseResult.meta.charCount} · 语言 {parseResult.meta.language} · 分段 {parseResult.meta.segmentCount}
              {parseResult.meta.piiFlags.length > 0 ? ` · 检测到 PII：${parseResult.meta.piiFlags.join('/')}` : ''}
              {parseResult.meta.injectionDetected ? ' · ⚠️ 检测到疑似提示注入（已隔离处理）' : ''}
            </p>
          </div>

          <div className="card">
            <h2>字段（可校准）</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              黄色高亮 = 建议复核。修改任意字段后，该字段会作为「已人工确认」提交。
            </p>
            <div className="field-grid">
              <div className={`field ${needsReview.includes('company') ? 'review' : ''}`}>
                <label htmlFor="f-company">公司</label>
                <input
                  id="f-company"
                  style={{ width: '100%' }}
                  value={company}
                  onChange={(event) => {
                    setCompany(event.target.value);
                    markEdited('company');
                  }}
                />
                <div className="evidence">依据：{parseResult.extraction.evidence['company'] ?? '—'}</div>
              </div>

              <div className={`field ${needsReview.includes('title') ? 'review' : ''}`}>
                <label htmlFor="f-title">岗位</label>
                <input
                  id="f-title"
                  style={{ width: '100%' }}
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    markEdited('title');
                  }}
                />
                <div className="evidence">依据：{parseResult.extraction.evidence['title'] ?? '—'}</div>
              </div>

              <div className={`field ${needsReview.includes('cities') ? 'review' : ''}`}>
                <label htmlFor="f-cities">城市（用分号分隔）</label>
                <input
                  id="f-cities"
                  style={{ width: '100%' }}
                  value={citiesText}
                  onChange={(event) => {
                    setCitiesText(event.target.value);
                    markEdited('cities');
                  }}
                />
                <div className="evidence">"全国/多地" 可留空</div>
              </div>

              <div className={`field ${needsReview.includes('salary_min') ? 'review' : ''}`}>
                <label htmlFor="f-salary-min">薪资下限（元/月）</label>
                <input
                  id="f-salary-min"
                  style={{ width: '100%' }}
                  value={salaryMin}
                  onChange={(event) => {
                    setSalaryMin(event.target.value);
                    markEdited('salary_min');
                  }}
                />
                <div className="evidence">依据：{parseResult.extraction.evidence['salary_min'] ?? '—'}</div>
              </div>

              <div className={`field ${needsReview.includes('salary_max') ? 'review' : ''}`}>
                <label htmlFor="f-salary-max">薪资上限（元/月）</label>
                <input
                  id="f-salary-max"
                  style={{ width: '100%' }}
                  value={salaryMax}
                  onChange={(event) => {
                    setSalaryMax(event.target.value);
                    markEdited('salary_max');
                  }}
                />
                <div className="evidence">年薪会换算为月薪；面议时留空</div>
              </div>

              <div className={`field ${needsReview.includes('deadline') ? 'review' : ''}`}>
                <label htmlFor="f-deadline-kind">截止时间（JD 未写是合法的）</label>
                <div className="row">
                  <select
                    id="f-deadline-kind"
                    value={deadlineKind}
                    onChange={(event) => {
                      setDeadlineKind(event.target.value as DeadlineKind);
                      markEdited('deadline');
                    }}
                  >
                    <option value="provided">有明确日期</option>
                    <option value="text_only">模糊表述（招满为止）</option>
                    <option value="absent">JD 未提供</option>
                  </select>
                  <input
                    aria-label="截止日期或原文"
                    placeholder={deadlineKind === 'provided' ? '2026-11-20T23:59:59+08:00' : '原文，如"招满为止"'}
                    value={deadlineText}
                    onChange={(event) => {
                      setDeadlineText(event.target.value);
                      markEdited('deadline');
                    }}
                  />
                </div>
                <div className="evidence">依据：{parseResult.extraction.evidence['deadline'] ?? '—'}</div>
              </div>

              <div className="field">
                <label>学历 / 招聘类型 / 届别</label>
                <div className="value">
                  {parseResult.extraction.fields.education} · {parseResult.extraction.fields.job_type} ·{' '}
                  {parseResult.extraction.fields.graduation_year ?? '—'}
                </div>
              </div>

              <div className="field">
                <label>经验 / 工作方式 / 薪资月数</label>
                <div className="value small">
                  {parseResult.extraction.fields.experience_years
                    ? JSON.stringify(parseResult.extraction.fields.experience_years)
                    : '—'}{' '}
                  · {parseResult.extraction.fields.work_mode} · {parseResult.extraction.fields.salary_months ?? '—'}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>技能（明确 / 推测 分列）</h2>
            {(() => {
              const columns = splitSkills(parseResult.extraction.fields.skills);
              return (
                <div className="skill-columns skill-cols">
                  <div>
                    <h3>明确 · 必须（{columns.explicitMust.length}）</h3>
                    <div className="chips">
                      {columns.explicitMust.length === 0 ? <span className="muted small">—</span> : null}
                      {columns.explicitMust.map((text) => (
                        <span key={text} className="chip explicit">
                          {text}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3>明确 · 加分（{columns.explicitNice.length}）</h3>
                    <div className="chips">
                      {columns.explicitNice.length === 0 ? <span className="muted small">—</span> : null}
                      {columns.explicitNice.map((text) => (
                        <span key={text} className="chip explicit">
                          {text}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3>推测（{columns.inferred.length}）</h3>
                    <div className="chips">
                      {columns.inferred.length === 0 ? <span className="muted small">—</span> : null}
                      {columns.inferred.map((text) => (
                        <span key={text} className="chip inferred">
                          {text}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
            <p className="muted small">
              推测项来自 JD 的领域大类（如"深度学习"），只作参考；括号内是「置信度←原文依据」。
            </p>
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <h2 style={{ marginBottom: 4 }}>确认入库</h2>
                <p className="muted small" style={{ margin: 0 }}>
                  {requireConfirm
                    ? `有 ${needsReview.length} 个字段待确认${blockers.length > 0 ? `、${blockers.length} 项受阻` : ''}，请核对后勾选下方确认`
                    : '字段已齐备，可直接入库'}
                </p>
              </div>
              <div className="row">
                {requireConfirm ? (
                  <label className="row small" style={{ gap: 6 }}>
                    <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                    我已核对以上字段
                  </label>
                ) : null}
                <button type="button" onClick={() => void handleSave(false)} disabled={!canSave}>
                  {saving ? '提交中…' : '确认入库'}
                </button>
              </div>
            </div>

            {saveError ? <div className="banner danger" style={{ marginTop: 12 }}>{saveError}</div> : null}

            {saveResult?.status === 'created' ? (
              <div className="banner" style={{ marginTop: 12 }}>
                ✅ 已入库：<b>{saveResult.job?.company}</b> / {saveResult.job?.title}
                {saveResult.job?.review_flags.length ? `（${saveResult.job.review_flags.length} 个字段待确认）` : ''}
                <div style={{ marginTop: 8 }}>
                  <Link href="/jobs">查看岗位列表 →</Link>
                </div>
              </div>
            ) : null}

            {saveResult?.status === 'blocked' ? (
              <div className="banner danger" style={{ marginTop: 12 }}>
                <b>未能入库：</b>
                <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                  {(saveResult.messages ?? []).map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {saveResult?.status === 'duplicate' ? (
              <div className="banner warn" style={{ marginTop: 12 }}>
                ⚠️ 该岗位已存在：
                <b>{saveResult.duplicateOf?.company}</b> / {saveResult.duplicateOf?.title}
                <div className="row" style={{ marginTop: 8 }}>
                  <a className="small" href={`/jobs?highlight=${saveResult.duplicateOf?.id ?? ''}`}>
                    查看已有
                  </a>
                  <button type="button" className="secondary" onClick={() => void handleSave(true)} disabled={saving}>
                    仍然新建一条
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
