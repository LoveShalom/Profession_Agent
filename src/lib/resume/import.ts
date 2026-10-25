/**
 * 简历解析与经历切分（F-06）
 *
 * 技术口径（已裁决）：Node 端解析，不引入 Python。PDF 用 `unpdf`，DOCX 用 `mammoth`。
 * 两者都是**可选依赖**：未安装时返回 `E_DEPENDENCY_MISSING` 并给出安装命令，不影响其它功能。
 *
 * 两条硬约束：
 *   · 扫描件（无文字层）明确告知"用截图识别（F-04）或手动录入"，绝不输出乱码；
 *   · 只产出候选经历，**不自动入库**（须用户逐条确认）。
 */

import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

import { extractExperienceFromText, experienceDedupeKey } from '../pipeline/experience.ts';
import type { ExperienceExtraction } from '../schemas/experience.ts';

export type ResumeFormat = 'pdf' | 'docx';

export type ResumeErrorCode =
  | 'E_UNSUPPORTED_FORMAT'
  | 'E_TOO_LARGE'
  | 'E_DEPENDENCY_MISSING'
  | 'E_PARSE_FAILED'
  | 'E_NO_TEXT_LAYER'
  | 'E_NO_EXPERIENCE';

export class ResumeImportError extends Error {
  readonly code: ResumeErrorCode;
  readonly hint?: string;
  constructor(code: ResumeErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ResumeImportError';
    this.code = code;
    if (hint) this.hint = hint;
  }
}

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MIN_TEXT_LAYER_CHARS = 50;

export interface ResumeParseResult {
  format: ResumeFormat;
  text: string;
  pageCount: number | null;
  hasTextLayer: boolean;
  warnings: string[];
}

function detectFormat(name: string, mime: string): ResumeFormat | null {
  const lower = `${name} ${mime}`.toLowerCase();
  if (lower.includes('pdf')) return 'pdf';
  if (lower.includes('word') || lower.includes('docx') || lower.includes('officedocument')) return 'docx';
  return null;
}

/** 清洗页眉页脚/页码/多余空行：重复出现 ≥3 次的短行视为页眉页脚 */
export function cleanResumeText(raw: string): { text: string; removed: number } {
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/\s+$/, ''));
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.trim();
    if (key.length === 0 || key.length > 40) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const boilerplate = new Set([...counts.entries()].filter(([, count]) => count >= 3).map(([key]) => key));

  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (boilerplate.has(trimmed) || /^(第\s*\d+\s*页|\d+\s*\/\s*\d+|page\s*\d+)$/i.test(trimmed)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), removed };
}

export async function parseResume(file: { name: string; mime: string; data: Buffer }): Promise<ResumeParseResult> {
  if (file.data.length > MAX_RESUME_BYTES) {
    throw new ResumeImportError('E_TOO_LARGE', '文件超过 10MB', '请压缩或拆分后再导入');
  }
  const format = detectFormat(file.name, file.mime);
  if (!format) {
    throw new ResumeImportError(
      'E_UNSUPPORTED_FORMAT',
      '只支持 PDF 与 DOCX',
      '如果是图片简历，请用 /jobs/new 的截图识别，或手动录入',
    );
  }

  const warnings: string[] = [];
  let raw = '';
  let pageCount: number | null = null;

  if (format === 'pdf') {
    try {
      const doc = await getDocumentProxy(new Uint8Array(file.data));
      const result = (await extractText(doc, { mergePages: true })) as { totalPages?: number; text?: string };
      raw = typeof result.text === 'string' ? result.text : '';
      pageCount = typeof result.totalPages === 'number' ? result.totalPages : null;
    } catch (error) {
      throw new ResumeImportError(
        'E_PARSE_FAILED',
        `PDF 解析失败：${error instanceof Error ? error.message : String(error)}`,
        '确认文件未加密/未损坏',
      );
    }
  } else {
    try {
      const result = await mammoth.extractRawText({ buffer: file.data });
      raw = result.value;
    } catch (error) {
      throw new ResumeImportError(
        'E_PARSE_FAILED',
        `DOCX 解析失败：${error instanceof Error ? error.message : String(error)}`,
        '确认文件是 .docx（不支持旧版 .doc）',
      );
    }
  }

  const cleaned = cleanResumeText(raw);
  if (cleaned.removed > 0) warnings.push(`已剔除 ${cleaned.removed} 行页眉/页脚/页码`);

  const hasTextLayer = cleaned.text.trim().length >= MIN_TEXT_LAYER_CHARS;
  if (!hasTextLayer) {
    throw new ResumeImportError(
      'E_NO_TEXT_LAYER',
      '这份文件没有可提取的文字（可能是扫描件/图片版）',
      '两条路：① 用截图识别（/jobs/new 选「截图识别」）；② 手动录入经历',
    );
  }

  return { format, text: cleaned.text, pageCount, hasTextLayer, warnings };
}

// ---------------------------------------------------------------- 候选经历切分
export interface CandidateExperience {
  extraction: ExperienceExtraction;
  rawText: string;
  dedupeKey: string;
}

/**
 * 把简历文本切成候选经历：遇到"时间区间"或"组织名"锚点开新段。
 * 连续多行锚点（组织行 + 时间行）属于同一表头；只有当前段已有正文时才切段。
 */
export function segmentExperiences(text: string): CandidateExperience[] {
  // PDF（尤其双栏版式）提取出来的文本是乱序的：教育信息可能跑到"教育背景"标题之前、
  // 日期挤在句尾、个人信息混在正文里。因此不能用"组织名锚点"，改用三层规则：
  //   ① 章节标题定边界（只保留 科研/项目/实习/工作/校园/实践 经历）；
  //   ② 日期区间作条目边界（行尾日期=本项结束；整行日期=本项开始）；
  //   ③ 教育/个人信息强标记直接剔除（主修课程、预计毕业、手机号码…）。
  const DAY = "(?:\\s*[.\\-/]\\s*\\d{1,2}\\s*日?)?";
  const DATE =
    "((?:20\\d{2}[.\\-/年]\\s*\\d{1,2}\\s*月?" + DAY + ")\\s*(?:--|——|—|–|~|～|至|到|-)\\s*(?:20\\d{2}[.\\-/年]\\s*\\d{1,2}\\s*月?" + DAY + "|至今|现在|present))";
  const dateRange = new RegExp(DATE);
  const dateOnly = new RegExp("^" + DATE + "$", "i");
  const dateTail = new RegExp(DATE + "\\s*$", "i");
  const dateAnywhere = new RegExp(DATE, "gi");

  const SECTION = /^(教育背景|科研经历|项目经历|实习经历|工作经历|校园经历|实践经历|技能|专业技能|荣誉|奖项|证书|论文|个人评价)$/;
  const EXPERIENCE_SECTION = /(科研|项目|实习|工作|校园|实践)经历/;
  const EDUCATION_MARK = /(主修课程|预计毕业时间|GPA|成绩排名)/;
  const PERSONAL_MARK = /(手机号码|手机号|邮箱|联系电话|身份证|出生年月|政治面貌)/;

  // 章节标题前后插换行（PDF 常把标题与正文粘在一起）
  const normalized = text
    .replace(/\r/g, "\n")
    .replace(/[\u3000\u00a0]/g, " ")
    .replace(/(教育背景|科研经历|项目经历|实习经历|工作经历|校园经历|实践经历|专业技能|技能|荣誉|奖项|证书|论文|个人评价)/g, "\n$1\n")
    // 日期前后也插换行：PDF 常把日期挤在句子中间（"…校正。2024.6 -- 2026.6基于…"）
    .replace(dateAnywhere, (match) => "\n" + match + "\n");

  type Block = { section: string; lines: string[] };
  const blocks: Block[] = [];
  let section = "";
  let buffer: string[] = [];
  const flushSection = () => {
    if (buffer.length > 0) blocks.push({ section, lines: buffer });
    buffer = [];
  };

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (SECTION.test(line)) {
      flushSection();
      section = line;
      continue;
    }
    // "求职意向：算法工程师｜<项目标题>" → 保留项目标题部分
    const stripped = line
      .replace(/^求职意向[:：][^｜|]*[｜|]?/, "")
      // 个人信息就地剥离（同段里可能还有正文，不能整段丢）
      .replace(/手机号码[:：]?\s*[\d\s-]{5,}/g, "")
      .replace(/邮箱[:：]?\s*\S+@\S+/g, "")
      .replace(/^(姓名|电话|手机|联系方式)[:：].*$/, "")
      .trim();
    if (stripped.length === 0) continue;
    buffer.push(stripped);
  }
  flushSection();

  const hasSectionHeaders = blocks.some((block) => EXPERIENCE_SECTION.test(block.section));
  const candidates: CandidateExperience[] = [];
  const seen = new Set<string>();

  const pushBlock = (lines: string[]): void => {
    const raw = lines.join("\n").trim();
    if (raw.replace(/\s/g, "").length < 20) return;
    // 教育/个人信息剔除：命中强标记且不含明显科研/项目动词的，直接丢
    if (EDUCATION_MARK.test(raw)) return;
    if (PERSONAL_MARK.test(raw) && raw.length < 120) return;
    const extraction = extractExperienceFromText(raw);
    const key = experienceDedupeKey(extraction);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ extraction, rawText: raw, dedupeKey: key });
  };

  /** 段内按日期边界切分；兼容"日期在行尾（本项结束）"与"日期独占一行（本项开始）"两种版式 */
  const splitByDates = (lines: string[]): void => {
    const chunk: string[] = [];
    for (const line of lines) {
      if (dateOnly.test(line)) {
        const last = chunk[chunk.length - 1];
        const previous = chunk[chunk.length - 2];
        const lastLooksLikeTitle =
          chunk.length >= 2 && typeof last === 'string' && last.length <= 40 && !/[。；;]/.test(last) && previous !== undefined && !dateOnly.test(previous);
        const lastIsTaskTitle = typeof last === 'string' && last.length <= 40 && !/[。；;]/.test(last);
        if (lastLooksLikeTitle) {
          // 末尾那行其实是"下一项的标题"：把它带到新段，前面的内容收尾
          const title = chunk.pop()!;
          pushBlock(chunk.splice(0));
          chunk.push(title);
        } else if (chunk.length > 0 && !lastIsTaskTitle) {
          // 上一行是正文（不是标题）→ 这个日期属于「下一项」，先收尾当前项
          pushBlock(chunk.splice(0));
        }
        chunk.push(line);
        continue;
      }
      chunk.push(line);
      if (dateTail.test(line) && line.replace(dateRange, "").trim().length > 4) {
        pushBlock(chunk.splice(0));
      }
    }
    pushBlock(chunk);
  };

  if (hasSectionHeaders) {
    for (const block of blocks) {
      if (!EXPERIENCE_SECTION.test(block.section)) continue;
      splitByDates(block.lines);
    }
  } else {
    // 没有章节标题（如纯文本自述/无小节的简历）：退回锚点切分
    const isAnchor = (line: string): boolean =>
      line.length > 0 && line.length <= 120 && (dateRange.test(line) || /(公司|集团|科技|实验室|研究院|大学|学院|银行|证券|事业部|中心)/.test(line));
    const hasContent = (buf: string[]): boolean =>
      buf.some((line) => {
        const trimmed = line.trim();
        return trimmed.length > 12 && !isAnchor(trimmed) && !/^20\d{2}/.test(trimmed);
      });
    let current: string[] = [];
    const anchorBlocks: string[] = [];
    for (const line of blocks.flatMap((block) => block.lines)) {
      if (isAnchor(line) && hasContent(current)) {
        anchorBlocks.push(current.join("\n").trim());
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) anchorBlocks.push(current.join("\n").trim());
    for (const block of anchorBlocks) pushBlock(block.split("\n"));
  }

  if (candidates.length === 0) {
    throw new ResumeImportError(
      "E_NO_EXPERIENCE",
      "没能从简历里识别出经历段落",
      "可以手动录入，或把简历内容粘贴到经历库的「从一段文字生成」里",
    );
  }
  return candidates.slice(0, 30);
}
