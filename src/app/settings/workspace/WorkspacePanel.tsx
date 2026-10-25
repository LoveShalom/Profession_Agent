'use client';

import { useCallback, useEffect, useState } from 'react';

interface WorkspaceStatus {
  dir: string;
  source: 'config' | 'env' | 'default';
  exists: boolean;
  mainTableExists: boolean;
  rows: number;
  lastExportAt: string | null;
  attachments: number;
  files: { mainTable: string; skillsTable: string; readme: string; rawDir: string };
}

interface SyncReport {
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  deletedProtected: number;
  notYetExported: number;
  warnings: string[];
  changes: string[];
  backup?: string;
  dryRun: boolean;
}

const SOURCE_LABEL: Record<WorkspaceStatus['source'], string> = {
  config: '设置页保存的目录',
  env: '.env 的 WORKSPACE_DIR',
  default: '默认路径',
};

export default function WorkspacePanel() {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [dirInput, setDirInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** 导出成功后写出的文件绝对路径（让用户知道东西在哪） */
  const [exportedFiles, setExportedFiles] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/workspace', { cache: 'no-store' });
      const data = (await response.json()) as { ok: boolean; status?: WorkspaceStatus; error?: string };
      if (data.status) {
        setStatus(data.status);
        setDirInput((previous) => (previous.length > 0 ? previous : data.status!.dir));
      }
      if (!data.ok) setError(data.error ?? '读取状态失败');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('浏览器不允许写剪贴板，请手动选中路径复制');
    }
  }

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    setNote(null);
    setReport(null);
    try {
      const response = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        status?: WorkspaceStatus;
        report?: SyncReport;
        jobCount?: number;
        skillCount?: number;
        preservedColumns?: string[];
        warnings?: string[];
        files?: string[];
        backup?: string;
      };
      if (!data.ok) {
        setError(data.error ?? '操作失败');
        return;
      }
      if (data.status) setStatus(data.status);
      if (data.report) setReport(data.report);
      if (action === 'export') {
        setExportedFiles(Array.isArray(data.files) ? data.files : []);
        setNote(`已导出 ${data.jobCount ?? 0} 个岗位 / ${data.skillCount ?? 0} 条技能属性`);
      } else if (action === 'sync') {
        setNote('同步完成');
      } else if (action === 'setDir') {
        setNote('目录已保存（立即生效）');
      } else if (action === 'resetDir') {
        setNote('已回退到 .env 配置');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '网络错误');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>工作区台账</h2>
          <button type="button" className="secondary small" onClick={() => void load()} disabled={busy !== null}>
            刷新
          </button>
        </div>

        {status ? (
          <table style={{ marginTop: 12 }}>
            <tbody>
              <tr>
                <th style={{ width: 160 }}>当前目录</th>
                <td>
                  <code>{status.dir}</code>
                  <div className="muted small">来源：{SOURCE_LABEL[status.source]}</div>
                </td>
              </tr>
              <tr>
                <th>状态</th>
                <td>
                  {status.exists ? <span className="badge ok">目录存在</span> : <span className="badge warn">目录不存在（导出时自动创建）</span>}{' '}
                  {status.mainTableExists ? (
                    <span className="badge ok">台账 {status.rows} 行</span>
                  ) : (
                    <span className="badge">尚未导出台账</span>
                  )}{' '}
                  {status.attachments > 0 ? <span className="badge">截图附件 {status.attachments} 张</span> : null}
                </td>
              </tr>
              <tr>
                <th>上次导出</th>
                <td>{status.lastExportAt ? new Date(status.lastExportAt).toLocaleString() : '—'}</td>
              </tr>
              <tr>
                <th>文件</th>
                <td className="small">
                  <div>{status.files.mainTable}</div>
                  <div>{status.files.skillsTable}</div>
                  <div>{status.files.rawDir}</div>
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="muted">读取中…</p>
        )}
      </div>

      <div className="card">
        <h2>操作</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <button type="button" onClick={() => void post('export')} disabled={busy !== null}>
            {busy === 'export' ? '导出中…' : '导出最新台账'}
          </button>
          <button type="button" className="secondary" onClick={() => void post('sync', { dryRun: true })} disabled={busy !== null}>
            {busy === 'sync' ? '处理中…' : '预演同步（不写库）'}
          </button>
          <button type="button" onClick={() => void post('sync')} disabled={busy !== null}>
            同步回库
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          同步前会自动备份到 <code>.backup/</code>（保留最近 5 份）；在表格里删行不会删除数据库记录。
          改完表格请先关闭 Excel / WPS，否则文件被占用无法读取。
        </p>

        {note ? <div className="banner" style={{ marginTop: 12 }}>{note}</div> : null}

        {exportedFiles.length > 0 ? (
          <div className="banner" style={{ marginTop: 12 }}>
            <b>文件已写入以下位置</b>
            <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 20, fontFamily: 'ui-monospace, Consolas, monospace' }}>
              {exportedFiles.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="secondary small" onClick={() => void copy(status?.dir ?? '')}>
                {copied ? '已复制 ✓' : '复制工作区路径'}
              </button>
              <span className="muted small">
                在「文件资源管理器」地址栏粘贴该路径即可打开（浏览器不能直接打开本地文件夹）
              </span>
            </div>
          </div>
        ) : null}

        {error ? <div className="banner danger" style={{ marginTop: 12 }}>{error}</div> : null}

        {report ? (
          <div className="banner" style={{ marginTop: 12 }}>
            <b>{report.dryRun ? '预演结果（未写库）' : '同步结果'}</b>：更新 {report.updated} · 新增 {report.created} · 跳过{' '}
            {report.skipped} · 冲突 {report.conflicts} · 未导出新增 {report.notYetExported} · 受保护删行 {report.deletedProtected}
            {report.backup ? (
              <div className="small muted" style={{ marginTop: 6 }}>
                备份：{report.backup}
              </div>
            ) : null}
            {report.changes.length > 0 ? (
              <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {report.changes.slice(0, 10).map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            ) : null}
            {report.warnings.length > 0 ? (
              <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {report.warnings.map((warning) => (
                  <li key={warning}>⚠️ {warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2>更换目录</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          可以指向网盘同步目录（如 OneDrive / iCloud）做备份。保存后<strong>立即生效</strong>，不需要重启；
          留空并点「回退 .env」可恢复默认。
        </p>
        <div className="row">
          <input
            style={{ flex: 1, minWidth: 280 }}
            value={dirInput}
            onChange={(event) => setDirInput(event.target.value)}
            placeholder="例如 D:\\求职台账 或 ./data/workspace"
            aria-label="工作区目录"
          />
          <button type="button" onClick={() => void post('setDir', { dir: dirInput })} disabled={busy !== null || dirInput.trim().length === 0}>
            保存目录
          </button>
          <button type="button" className="secondary" onClick={() => void post('resetDir')} disabled={busy !== null}>
            回退 .env
          </button>
        </div>
      </div>
    </div>
  );
}
