/**
 * 工作区路径与文件布局（F-03 T1）
 *
 * 工作区就是用户自己指定的一个文件夹，布局固定、可整体删除重建：
 *
 *   <WORKSPACE_DIR>/
 *     ├─ 岗位管理表.csv     主表（23+ 列，可编辑）
 *     ├─ 技能明细表.csv     长表（只读透视）
 *     ├─ 同步冲突记录.csv   冲突审计（用户优先时记录）
 *     ├─ README.txt         给你自己看的使用说明
 *     ├─ 原始JD/           入库时的原文快照（含 attachments/ 图片）
 *     └─ .backup/          每次同步前的备份（保留最近 5 份）
 *
 * 路径来源：`WORKSPACE_DIR` 环境变量，默认 `./data/workspace`。
 * 这里直接读 `process.env` 而不进 `env.ts` 的强校验表：工作区缺失是**可恢复的非致命问题**
 * （导出时创建即可），不该阻塞应用启动。
 */

import path from 'node:path';

import { resolveWorkspaceDir as resolveDirWithOverride } from './settings.ts';

export interface WorkspacePaths {
  dir: string;
  mainTable: string;
  skillsTable: string;
  conflicts: string;
  readme: string;
  rawDir: string;
  backupDir: string;
  attachmentsDir: string;
  /** 经历库导出（只读备份，不参与双向同步） */
  experiencesTable: string;
  /** 导出元数据（记录导出时间，用于区分「表格落后」与「用户删行」） */
  exportMeta: string;
}

/**
 * 最终生效的工作区目录：运行时配置（设置页写入）> `.env` 的 `WORKSPACE_DIR` > 默认。
 * 实现见 `settings.ts`——改目录立即生效，不需要重启进程。
 */
export function resolveWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDirWithOverride(env);
}

export function workspacePaths(dir: string = resolveWorkspaceDir()): WorkspacePaths {
  return {
    dir,
    mainTable: path.join(dir, '岗位管理表.csv'),
    skillsTable: path.join(dir, '技能明细表.csv'),
    conflicts: path.join(dir, '同步冲突记录.csv'),
    readme: path.join(dir, 'README.txt'),
    rawDir: path.join(dir, '原始JD'),
    attachmentsDir: path.join(dir, '原始JD', 'attachments'),
    backupDir: path.join(dir, '.backup'),
    experiencesTable: path.join(dir, '经历库.csv'),
    exportMeta: path.join(dir, '.export-meta.json'),
  };
}

export const README_TEXT = `岗位台账使用说明（由工具生成，可自由修改本文件）

【这是什么】
  这是你的岗位库的"可编辑副本"。工具（Profession Search Agent）把岗位数据导出成 CSV，
  你可以用 Excel / WPS / Numbers 打开、筛选、排序、改状态，然后运行同步命令把改动写回数据库。

【怎么用】
  1. 导出最新台账：npm run workspace:export
  2. 用 Excel 打开「岗位管理表.csv」，改你需要的列（见下方"可改的列"）
  3. 保存并关闭 Excel（一定要关闭，否则文件被占用无法读取）
  4. 同步回库：npm run workspace:sync

【可改的列】（改了会写回数据库）
  状态、优先级、下一步、下一步时间、备注
  以及抽取字段的人工校准：公司、岗位、城市、招聘类型、届别、学历、
  薪资下限、薪资上限、薪资月数、截止时间、技能·明确(必须)、技能·明确(加分)

【不要改的列】（只读；改了不生效，下次导出会被恢复）
  岗位ID、_rev、经验、技能·推测、待确认字段、剩余天数

【安全机制】
  · 每次同步前会自动备份到 .backup/（保留最近 5 份）
  · 在表格里删掉一行**不会**删除数据库记录（下次导出会补回来）
  · 如果同一字段你和系统都改过，以**你的值**为准，并记入「同步冲突记录.csv」
  · 想加自己的列（比如"内推人"）：随便加，工具不会读也不会动它

【注意】
  · 「原始JD/」目录含招聘原文与截图，可能包含个人信息，分享台账前请先清理该目录
  · 不要把 .env（含密钥）放进来
`;
