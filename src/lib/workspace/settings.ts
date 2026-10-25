/**
 * 工作区运行时配置（F-03 T3）
 *
 * `WORKSPACE_DIR` 在 `.env` 里，但改环境变量需要重启进程——而"设置页改目录立即生效"
 * 是 F-03 的验收点。因此引入一个**运行时覆盖文件**：
 *
 *   data/workspace-config.json  { "dir": "D:/求职台账", "updatedAt": "..." }
 *
 * 优先级：配置文件 > `.env` 的 WORKSPACE_DIR > 默认 `./data/workspace`。
 * 为什么不写回 `.env`：`.env` 里有密钥，让运行时业务逻辑去改写它风险太高
 * （编码、并发、误删密钥），配置文件更安全也更简单。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function workspaceConfigPath(): string {
  return path.resolve(process.env['WORKSPACE_CONFIG_PATH'] ?? 'data/workspace-config.json');
}

export interface WorkspaceConfig {
  dir: string;
  updatedAt: string;
}

/** 读取运行时覆盖；文件不存在或损坏时返回 null（不抛错） */
export function readWorkspaceConfig(): WorkspaceConfig | null {
  try {
    if (!existsSync(workspaceConfigPath())) return null;
    const parsed = JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Partial<WorkspaceConfig>;
    const dir = typeof parsed.dir === 'string' ? parsed.dir.trim() : '';
    if (dir.length === 0) return null;
    return { dir, updatedAt: String(parsed.updatedAt ?? '') };
  } catch {
    return null;
  }
}

/** 写入运行时覆盖（原子写：先写临时文件再 rename，避免半截 JSON） */
export function writeWorkspaceConfig(dir: string): WorkspaceConfig {
  const absolute = path.resolve(dir.trim());
  const config: WorkspaceConfig = { dir: absolute, updatedAt: new Date().toISOString() };
  mkdirSync(path.dirname(workspaceConfigPath()), { recursive: true });
  const target = workspaceConfigPath();
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(temp, target);
  return config;
}

/** 清除运行时覆盖（回退到 `.env` / 默认） */
export function clearWorkspaceConfig(): void {
  if (existsSync(workspaceConfigPath())) writeFileSync(workspaceConfigPath(), '{}\n', 'utf8');
}

/** 解析最终生效的目录：配置文件 > .env > 默认 */
export function resolveWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = readWorkspaceConfig();
  if (override) return path.resolve(override.dir);
  const configured = (env['WORKSPACE_DIR'] ?? '').trim();
  return path.resolve(configured.length > 0 ? configured : './data/workspace');
}

/** 目录是否可用（能创建/写入） */
export function ensureWorkspaceDir(dir: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(dir, { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
