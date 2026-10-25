/**
 * .env 缺失键补全（F-01 setup 增强 / 2026-10-25）
 *
 * 背景：用户机器上的 `.env` 是早期生成的，后续新增的配置键（如 `LLM_VISION_*`、`WORKSPACE_DIR`）
 * 不会自动出现——`setup.mjs` 原先只补 4 个特定键，导致"文档说要配、文件里没这个键"。
 *
 * 规则（与 setup 的幂等约定一致）：
 *   · **只补键名完全缺失的键**；已有键（哪怕值为空）一律不动；
 *   · 补的时候连同模板里该键**上方的注释块**一起带过来，避免出现"没有说明的裸键"；
 *   · 纯函数，便于单测；不读文件、不感知 cwd。
 */

export interface MissingEnvKey {
  key: string;
  /** 模板里该键上方的注释行 */
  comment: string[];
  /** 模板里的完整赋值行（含默认值） */
  line: string;
}

const KEY_LINE = /^([A-Z][A-Z0-9_]*)=/;

/** 找出模板中有、当前文件中完全没有的键 */
export function collectMissingEnvKeys(current: string, template: string): MissingEnvKey[] {
  const existing = new Set(
    [...current.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!),
  );
  const templateLines = template.split('\n');
  const missing: MissingEnvKey[] = [];

  for (let index = 0; index < templateLines.length; index += 1) {
    const line = templateLines[index]!;
    const match = KEY_LINE.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (existing.has(key)) continue;

    const comment: string[] = [];
    for (let back = index - 1; back >= 0; back -= 1) {
      const previous = templateLines[back]!;
      if (previous.startsWith('#')) comment.unshift(previous);
      else break;
    }
    missing.push({ key, comment, line });
  }
  return missing;
}

/**
 * 把缺失键追加到文本末尾（带注释块 + 分组标题）。
 * 没有任何缺失时原样返回，保证幂等（重复执行不产生 diff）。
 */
export function applyMissingEnvKeys(current: string, template: string): { text: string; added: string[] } {
  const missing = collectMissingEnvKeys(current, template);
  if (missing.length === 0) return { text: current, added: [] };

  const blocks = missing.map((item) => [...item.comment, item.line].join('\n'));
  const section = [
    '',
    '# ---------- 由 setup 从 .env.example 自动补齐的缺失键（值沿用模板默认）----------',
    ...blocks,
    '',
  ].join('\n');

  return { text: `${current.trimEnd()}${section}`, added: missing.map((item) => item.key) };
}
