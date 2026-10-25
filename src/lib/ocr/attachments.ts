/**
 * 截图附件落盘（F-04 T4）
 *
 * 为什么存：JD 原始文字可回放，**截图却是唯一能证明"系统没看错"的证据**。
 * 存哪里：`<WORKSPACE_DIR>/原始JD/attachments/<sha256 前 16 位>.<ext>`——
 *   放在工作区里，用户随手备份/迁移台账就一起带走了。
 *
 * 去重：按内容 sha256 命名。同一张图重复识别不会产生多份文件；
 * 也天然形成"内容寻址"，不会因为重命名而重复占盘。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { workspacePaths, resolveWorkspaceDir } from '../workspace/paths.ts';

export interface AttachmentResult {
  /** 相对工作区根目录的路径（写进 `jd_structured.source_image`，换机器也能对应） */
  relativePath: string;
  /** 绝对路径（仅用于日志/排查，不落库） */
  absolutePath: string;
  bytes: number;
  /** 命中已存在的同内容文件 */
  deduped: boolean;
  sha256: string;
}

const DATA_URL_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i;

function extensionOf(mime: string): string {
  const normalized = mime.toLowerCase();
  if (normalized === 'jpeg' || normalized === 'jpg') return 'jpg';
  if (normalized === 'webp') return 'webp';
  return 'png';
}

/**
 * 保存一张截图。非 data URL 直接报错（API 层已做格式校验，这里是最后一道防线）。
 */
export function saveAttachment(dataUrl: string, options: { dir?: string } = {}): AttachmentResult {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) throw new Error('不是受支持的图片 data URL（PNG/JPEG/WebP）');
  const mime = match[1]!;
  const buffer = Buffer.from(match[2]!, 'base64');
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  const dir = options.dir ?? resolveWorkspaceDir();
  const paths = workspacePaths(dir);
  mkdirSync(paths.attachmentsDir, { recursive: true });

  const filename = `${sha256.slice(0, 16)}.${extensionOf(mime)}`;
  const absolutePath = path.join(paths.attachmentsDir, filename);
  const deduped = existsSync(absolutePath);
  if (!deduped) writeFileSync(absolutePath, buffer);

  return {
    relativePath: `原始JD/attachments/${filename}`,
    absolutePath,
    bytes: buffer.length,
    deduped,
    sha256,
  };
}

/** 删除某个岗位的附件（岗位删除时调用；返回是否删掉了文件） */
export function removeAttachment(relativePath: string, options: { dir?: string } = {}): boolean {
  const dir = options.dir ?? resolveWorkspaceDir();
  const absolute = path.resolve(dir, relativePath);
  // 防目录穿越：必须落在 attachments 目录内
  const allowed = path.resolve(workspacePaths(dir).attachmentsDir);
  if (!absolute.startsWith(allowed + path.sep)) return false;
  try {
    if (!existsSync(absolute)) return false;
    unlinkSync(absolute);
    return true;
  } catch {
    return false;
  }
}
