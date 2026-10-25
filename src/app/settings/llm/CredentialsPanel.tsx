'use client';

import { useCallback, useEffect, useState } from 'react';

const ROLE_LABEL: Record<'text' | 'vision', string> = {
  text: '文本模型（抽取/生成）',
  vision: '视觉模型（截图识别）',
};
const PRESETS = ['deepseek', 'qwen', 'kimi', 'glm', 'siliconflow', 'openai', 'ollama', 'custom'];

interface Summary {
  role: 'text' | 'vision';
  provider: string;
  baseUrl: string;
  model: string;
  keyLast4: string;
  status: string;
  lastVerifiedAt: string | null;
}

export default function CredentialsPanel() {
  const [items, setItems] = useState<Summary[]>([]);
  const [role, setRole] = useState<'text' | 'vision'>('text');
  const [provider, setProvider] = useState('deepseek');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/credentials', { cache: 'no-store' });
      const data = (await response.json()) as { credentials?: Summary[]; error?: string };
      if (data.error) setError(data.error);
      setItems(data.credentials ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch('/api/settings/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, provider, model, baseUrl, apiKey }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        error?: { message?: string; hint?: string } | string;
        credentials?: Summary[];
      };
      if (!data.ok) {
        const message = typeof data.error === 'string' ? data.error : (data.error?.message ?? '保存失败');
        const hint = typeof data.error === 'object' && data.error?.hint ? `（${data.error.hint}）` : '';
        setError(`${message}${hint}`);
        return;
      }
      setNote('已保存并通过连通性验证（立即生效，优先于 .env）');
      setApiKey('');
      setItems(data.credentials ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: Summary) {
    await fetch(
      `/api/settings/credentials?provider=${encodeURIComponent(target.provider)}&baseUrl=${encodeURIComponent(target.baseUrl)}`,
      { method: 'DELETE' },
    );
    await load();
  }

  return (
    <div>
      <div className="card">
        <h2>已保存的凭证</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          只显示 Key 尾号；明文不落库、不回传。设置页保存的凭证<strong>优先于 .env</strong>，删除后自动回退 .env。
        </p>
        {items.length === 0 ? (
          <p className="muted">还没有保存凭证，当前使用 .env 配置。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>用途</th>
                <th>服务商</th>
                <th>模型</th>
                <th>Key</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.role}-${item.provider}-${item.baseUrl}`}>
                  <td>{ROLE_LABEL[item.role]}</td>
                  <td>{item.provider}</td>
                  <td>{item.model || '(默认)'}</td>
                  <td>••••{item.keyLast4}</td>
                  <td>
                    {item.status === 'active' ? <span className="badge ok">已验证</span> : <span className="badge warn">{item.status}</span>}
                  </td>
                  <td>
                    <button type="button" className="secondary small" onClick={() => void remove(item)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>添加 / 更新凭证</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          {(['text', 'vision'] as const).map((value) => (
            <button key={value} type="button" className={role === value ? undefined : 'secondary'} onClick={() => setRole(value)}>
              {ROLE_LABEL[value]}
            </button>
          ))}
        </div>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="c-provider">服务商</label>
            <select id="c-provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
              {PRESETS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-model">模型名（可空 = 默认）</label>
            <input
              id="c-model"
              style={{ width: '100%' }}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="deepseek-chat / qwen-vl-plus"
            />
          </div>
          <div className="field">
            <label htmlFor="c-base">Base URL（custom / 中转站才需要）</label>
            <input
              id="c-base"
              style={{ width: '100%' }}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://你的网关/v1"
            />
          </div>
          <div className="field">
            <label htmlFor="c-key">API Key</label>
            <input
              id="c-key"
              type="password"
              style={{ width: '100%' }}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" onClick={() => void save()} disabled={busy}>
            {busy ? '验证中…' : '验证并保存'}
          </button>
          <span className="muted small">保存前会真实探活一次；失败不会写入</span>
        </div>
        {note ? <div className="banner" style={{ marginTop: 12 }}>{note}</div> : null}
        {error ? <div className="banner danger" style={{ marginTop: 12 }}>{error}</div> : null}
      </div>
    </div>
  );
}
