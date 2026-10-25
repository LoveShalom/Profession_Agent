#!/usr/bin/env node
/**
 * 工作区 CLI（F-03 T1/T2）
 *
 *   node scripts/workspace.mjs export [--dir <路径>]
 *   node scripts/workspace.mjs sync   [--dir <路径>] [--dry-run]
 *
 * 走真实数据库（需要 Docker 已起、迁移已应用）。导出/同步逻辑都在 src/lib/workspace，
 * 这里只负责读 .env、拿 userId、打印结果——保证 CLI 与 UI 走同一条代码路径。
 */

import { readFileSync } from 'node:fs';

import { createPostgresJobRepository } from '../src/lib/db/postgres.ts';
import { createPostgresExperienceRepository } from '../src/lib/experience/service.ts';
import { validateEnv } from '../src/lib/env.ts';
import { resolveTenant } from '../src/lib/tenant.ts';
import { exportWorkspace } from '../src/lib/workspace/export.ts';
import { resolveWorkspaceDir, workspacePaths } from '../src/lib/workspace/paths.ts';
import { syncWorkspace } from '../src/lib/workspace/sync.ts';

function readEnvFile() {
  const parsed = {};
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index <= 0) continue;
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) parsed[trimmed.slice(0, index).trim()] = value;
    }
  } catch {
    /* 没有 .env 时用 process.env 兜底 */
  }
  return parsed;
}

const argv = process.argv.slice(2);
const command = argv[0];
const dirIndex = argv.indexOf('--dir');
const dir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;
const dryRun = argv.includes('--dry-run');

if (command !== 'export' && command !== 'sync') {
  console.log('用法：node scripts/workspace.mjs <export|sync> [--dir <路径>] [--dry-run]');
  process.exit(2);
}

const loaded = validateEnv({ ...readEnvFile(), ...process.env });
if (!loaded.ok) {
  console.error('❌ .env 校验失败，请先运行 npm run setup / npm run doctor');
  for (const issue of loaded.issues.filter((item) => item.severity === 'error')) {
    console.error(`   - ${issue.key}: ${issue.message}`);
  }
  process.exit(2);
}

const env = loaded.env;
const tenant = resolveTenant(env);
const repo = await createPostgresJobRepository(env.databaseUrl);
const workspace = workspacePaths(dir ?? resolveWorkspaceDir());

try {
  if (command === 'export') {
    const experienceRepo = await createPostgresExperienceRepository(env.databaseUrl);
    const experiences = await experienceRepo.list(tenant.userId).catch(() => []);
    const result = await exportWorkspace(repo, tenant.userId, { dir: workspace.dir, experiences });
    console.log(`✅ 已导出 ${result.jobCount} 个岗位 / ${result.skillCount} 条技能属性 / ${result.experienceCount} 段经历`);
    console.log(`   目录：${result.dir}`);
    for (const file of result.files) console.log(`   - ${file}`);
    if (result.preservedColumns.length > 0) {
      console.log(`   已保留你的自建列：${result.preservedColumns.join(', ')}`);
    }
    for (const warning of result.warnings) console.log(`   ⚠️ ${warning}`);
  } else {
    const report = await syncWorkspace(repo, tenant.userId, { dir: workspace.dir, dryRun });
    console.log(dryRun ? '🔍 同步预演（不写库）' : '✅ 同步完成');
    console.log(`   更新 ${report.updated} · 新增 ${report.created} · 跳过 ${report.skipped} · 冲突 ${report.conflicts} · 未导出新增 ${report.notYetExported} · 受保护删行 ${report.deletedProtected}`);
    if (report.backup) console.log(`   同步前备份：${report.backup}`);
    for (const change of report.changes.slice(0, 20)) console.log(`   · ${change}`);
    if (report.changes.length > 20) console.log(`   …另有 ${report.changes.length - 20} 条`);
    for (const warning of report.warnings) console.log(`   ⚠️ ${warning}`);
    if (report.conflicts > 0) console.log(`   冲突明细见：${workspace.conflicts}`);
  }
  process.exit(0);
} catch (error) {
  console.error(`❌ ${command} 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
