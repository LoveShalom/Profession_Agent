/**
 * CSV 编解码（F-03 / T1）
 *
 * 三件事必须做对，否则用户一打开 Excel 就出问题：
 *   1. **UTF-8 BOM**：没有 BOM 时 Windows Excel 会把中文解成乱码；
 *   2. **RFC4180 转义**：值里有逗号/引号/换行时必须加引号并把 `"` 写成 `""`；
 *   3. **公式注入防护**：`=` `+` `-` `@` 开头的值前置 `'`，否则 Excel 会当公式执行。
 *
 * 解码同样要宽容：Excel 可能把 `2026-11-20` 存成 `2026/11/20`，把全角 `；` 带进来，
 * 也可能在末尾补空行。解析器只负责"把文本变成二维数组"，语义归一由上层做。
 */

export const UTF8_BOM = '\uFEFF';

/** 需要转义的字符：逗号、双引号、换行 */
function needsQuote(value: string): boolean {
  return value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r');
}

/** 防公式注入：Excel/Sheets 会把以这些字符开头的单元格当公式 */
function guardFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** 单字段编码（先转义，再防注入——注入前缀 `'` 不需要再加引号） */
export function encodeCsvField(value: string): string {
  const guarded = guardFormula(value);
  return needsQuote(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** 二维数组 → CSV 文本（**不含 BOM**；写文件时由调用方补） */
export function encodeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(encodeCsvField).join(',')).join('\r\n');
}

/** 写文件用的完整内容：BOM + CSV + 末尾换行 */
export function encodeCsvDocument(rows: readonly (readonly string[])[]): string {
  return `${UTF8_BOM}${encodeCsv(rows)}\r\n`;
}

export interface CsvParseResult {
  rows: string[][];
  /** 解析过程中的宽容处理记录（例如引号未闭合） */
  warnings: string[];
}

/**
 * CSV 文本 → 二维数组。支持：
 *   · 带/不带 BOM
 *   · 引号包裹的字段（内含逗号、换行、`""` 转义）
 *   · CRLF / LF / CR 混用
 *   · 末尾空行自动丢弃
 */
export function parseCsv(input: string): CsvParseResult {
  const warnings: string[] = [];
  const text = input.startsWith(UTF8_BOM) ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  if (inQuotes) warnings.push('存在未闭合的引号，已按到文件末尾处理');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 丢弃完全空白的尾行（Excel 常见）
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0]!.trim() === '') rows.pop();
    else break;
  }

  return { rows, warnings };
}
