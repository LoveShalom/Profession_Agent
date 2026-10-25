/**
 * /api/workspace —— 工作区状态与操作（F-03 T3）
 *
 *   GET                       → 目录/台账状态（行数、上次导出时间、附件数）
 *   POST { action: 'export' }              → 导出 CSV 台账
 *   POST { action: 'sync', dryRun?: bool } → 同步回库（可预演）
 *   POST { action: 'setDir', dir }         → 改工作区目录（立即生效，无需重启）
 *   POST { action: 'resetDir' }            → 清除运行时覆盖，回退 .env
 *
 * 与 CLI（`npm run workspace:export|sync`）共用同一套业务函数，保证行为一致。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

import { getJobRepository } from '@/lib/db/factory.ts';
import { getExperienceRepository } from '@/lib/experience/factory.ts';
import { getEnv } from '@/lib/server/env.ts';
import { resolveTenant } from '@/lib/tenant.ts';
import { parseCsv } from '@/lib/workspace/csv.ts';
import { exportWorkspace } from '@/lib/workspace/export.ts';
import { workspacePaths } from '@/lib/workspace/paths.ts';
import {
  clearWorkspaceConfig,
  ensureWorkspaceDir,
  readWorkspaceConfig,
  resolveWorkspaceDir,
  writeWorkspaceConfig,
} from '@/lib/workspace/settings.ts';
import { syncWorkspace } from '@/lib/workspace/sync.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function collectStatus() {
  const dir = resolveWorkspaceDir();
  const paths = workspacePaths(dir);
  const override = readWorkspaceConfig();
  const source = override ? 'config' : (process.env['WORKSPACE_DIR'] ?? '').trim() ? 'env' : 'default';

  let rows = 0;
  let lastExportAt: string | null = null;
  if (existsSync(paths.mainTable)) {
    try {
      rows = Math.max(0, parseCsv(readFileSync(paths.mainTable, 'utf8')).rows.length - 1);
      lastExportAt = statSync(paths.mainTable).mtime.toISOString();
    } catch {
      /* 文件不可读时按 0 行展示 */
    }
  }
  const attachments = existsSync(paths.attachmentsDir) ? readdirSync(paths.attachmentsDir).length : 0;

  return {
    dir,
    source,
    exists: existsSync(dir),
    mainTableExists: existsSync(paths.mainTable),
    rows,
    lastExportAt,
    attachments,
    files: {
      mainTable: paths.mainTable,
      skillsTable: paths.skillsTable,
      readme: paths.readme,
      rawDir: paths.rawDir,
    },
  };
}

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, status: collectStatus() });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const payload = body as { action?: unknown; dir?: unknown; dryRun?: unknown };
  const action = payload.action;

  try {
    if (action === 'setDir') {
      const dir = typeof payload.dir === 'string' ? payload.dir.trim() : '';
      if (dir.length === 0) return Response.json({ ok: false, error: '目录不能为空' }, { status: 400 });
      const ensured = ensureWorkspaceDir(dir);
      if (!ensured.ok) {
        return Response.json({ ok: false, error: `目录不可用：${ensured.error ?? '未知原因'}` }, { status: 422 });
      }
      writeWorkspaceConfig(dir);
      return Response.json({ ok: true, status: collectStatus() });
    }

    if (action === 'resetDir') {
      clearWorkspaceConfig();
      return Response.json({ ok: true, status: collectStatus() });
    }

    if (action !== 'export' && action !== 'sync') {
      return Response.json({ ok: false, error: '未知 action' }, { status: 400 });
    }

    const env = getEnv();
    const userId = resolveTenant(env).userId;
    const repo = await getJobRepository();
    const dir = resolveWorkspaceDir();

    if (action === 'export') {
      // 经历库是只读备份：读不到也不阻塞岗位台账导出
      let experiences: Awaited<ReturnType<Awaited<ReturnType<typeof getExperienceRepository>>['list']>> = [];
      try {
        const experienceRepo = await getExperienceRepository();
        experiences = await experienceRepo.list(userId);
      } catch {
        experiences = [];
      }
      const result = await exportWorkspace(repo, userId, { dir, experiences });
      return Response.json({ ok: true, action, ...result, status: collectStatus() });
    }

    const report = await syncWorkspace(repo, userId, { dir, dryRun: payload.dryRun === true });
    return Response.json({ ok: report.warnings.every((warning) => !warning.includes('找不到台账文件')), action, report, status: collectStatus() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
