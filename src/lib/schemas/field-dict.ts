/**
 * 字段字典 v1（G-01）—— 18 个编号 / 21 个字段值
 *
 * 来源：tech_stack.md §9.2.0。这里是**唯一**的字段清单真源：
 * Zod schema、JSON Schema、UI 表单、评测标注都从这里派生或对齐，
 * 避免"文档写 18 个字段、代码里多一个少一个"的漂移。
 *
 * 为什么用「编号 + ids 数组」而不是平铺 18 个字段：
 * 字典按"业务字段"编号（18 个），但第 7/16/17 号是**组合字段**
 * （salary_min+salary_max / is_referral+referral_code / source+source_url），
 * 实际字段值是 21 个。评测按 18 个编号统计、组合字段整组正确才算对（G-02）。
 */

export type FieldId =
  | 'company'
  | 'title'
  | 'job_type'
  | 'graduation_year'
  | 'cities'
  | 'work_mode'
  | 'salary_min'
  | 'salary_max'
  | 'salary_months'
  | 'salary_negotiable'
  | 'education'
  | 'experience_years'
  | 'skills'
  | 'deadline'
  | 'deadline_text'
  | 'channel'
  | 'is_referral'
  | 'referral_code'
  | 'source'
  | 'source_url'
  | 'raw_text';

export interface FieldDictEntry {
  /** 字典编号 1–18（评测统计粒度） */
  no: number;
  /** 该编号下的实际字段值 */
  ids: readonly FieldId[];
  label: string;
  required: boolean;
  /**
   * 组合字段中"部分必填"的例外，如 #17 source 必填但 source_url 不必填。
   * 缺省表示跟随 `required`。
   */
  requiredIds?: readonly FieldId[];
  /** 是否需要用户人工确认后才可入库（G-01 最后一列） */
  manualConfirm: boolean;
  normalize: string;
}

export const FIELD_DICT_V1: readonly FieldDictEntry[] = [
  { no: 1, ids: ['company'], label: '公司', required: true, manualConfirm: false, normalize: '去空白、统一全半角；指纹用去后缀版本' },
  { no: 2, ids: ['title'], label: '岗位', required: true, manualConfirm: false, normalize: '保留原值展示；指纹用去括号后缀版本' },
  { no: 3, ids: ['job_type'], label: '招聘类型', required: false, manualConfirm: false, normalize: '校招 / 社招 / 实习 / 提前批 / 未知' },
  { no: 4, ids: ['graduation_year'], label: '毕业年份', required: false, manualConfirm: false, normalize: '"2027届" → 2027' },
  { no: 5, ids: ['cities'], label: '城市', required: true, manualConfirm: false, normalize: '别名归一；"全国/多地" → 空数组 + warning' },
  { no: 6, ids: ['work_mode'], label: '工作方式', required: false, manualConfirm: false, normalize: 'onsite / hybrid / remote / 未知' },
  { no: 7, ids: ['salary_min', 'salary_max'], label: '薪资区间', required: false, manualConfirm: true, normalize: '元/月；"15k-25k"→15000/25000；"年薪30万"→换算月' },
  { no: 8, ids: ['salary_months'], label: '薪资月数', required: false, manualConfirm: false, normalize: '"14薪" → 14' },
  { no: 9, ids: ['salary_negotiable'], label: '薪资面议', required: false, manualConfirm: true, normalize: '"面议/薪资面谈" → true 且 min/max 置空' },
  { no: 10, ids: ['education'], label: '学历要求', required: false, manualConfirm: false, normalize: '不限 / 大专 / 本科 / 硕士 / 博士' },
  { no: 11, ids: ['experience_years'], label: '经验年限', required: false, manualConfirm: false, normalize: '{min,max,unlimited}；"3-5年"→{3,5}；"不限"→{unlimited:true}' },
  { no: 12, ids: ['skills'], label: '技能', required: false, manualConfirm: false, normalize: '经 C-07 词表归一；属性（明确/推测·必需性·熟练度）走 R-4' },
  { no: 13, ids: ['deadline'], label: '截止时间', required: false, manualConfirm: true, normalize: '三态 provided/text_only/absent；仅日期取当日 23:59:59+08:00' },
  { no: 14, ids: ['deadline_text'], label: '截止原文', required: false, manualConfirm: false, normalize: '原文片段；"长期有效/招满为止"记于此' },
  { no: 15, ids: ['channel'], label: '投递渠道', required: false, manualConfirm: false, normalize: '官网 / BOSS / 猎聘 / 国聘 / NCSS / 内推 / 其他' },
  { no: 16, ids: ['is_referral', 'referral_code'], label: '内推', required: false, manualConfirm: false, normalize: '内推标记与内推码' },
  { no: 17, ids: ['source', 'source_url'], label: '来源', required: true, requiredIds: ['source'], manualConfirm: false, normalize: 'manual / guopin / ncss / resume_import / plugin' },
  { no: 18, ids: ['raw_text'], label: '原文', required: true, manualConfirm: false, normalize: '原文，永不改写' },
];

/** 18 个编号（评测统计粒度：宏平均按编号算，组合字段整组正确才算对） */
export const FIELD_NUMBERS = FIELD_DICT_V1.map((entry) => entry.no);

/** 21 个字段值 id */
export const FIELD_IDS: readonly FieldId[] = FIELD_DICT_V1.flatMap((entry) => entry.ids);

/** 必填字段（缺失即视为抽取失败，而非"JD 没写"） */
export const REQUIRED_FIELD_IDS: readonly FieldId[] = FIELD_DICT_V1.flatMap((entry) =>
  entry.required ? (entry.requiredIds ?? entry.ids) : [],
);

/**
 * 需人工确认字段。
 * 注意 deadline 的三态（R-3）：只有 `provided` 态才需要确认；`text_only`/`absent` 属合法空态。
 */
export const MANUAL_CONFIRM_FIELD_IDS: readonly FieldId[] = FIELD_DICT_V1.filter((e) => e.manualConfirm).flatMap((e) => e.ids);

const FIELD_ID_SET: ReadonlySet<string> = new Set(FIELD_IDS);
const LABEL_BY_ID: ReadonlyMap<string, string> = new Map(
  FIELD_DICT_V1.flatMap((entry) => entry.ids.map((id) => [id, entry.label] as const)),
);

export function isFieldId(value: string): value is FieldId {
  return FIELD_ID_SET.has(value);
}

export function fieldLabel(id: FieldId): string {
  return LABEL_BY_ID.get(id) ?? id;
}

/** 组合字段整组判定用：返回该字段所属编号下的全部字段 */
export function siblingFieldIds(id: FieldId): readonly FieldId[] {
  const entry = FIELD_DICT_V1.find((e) => e.ids.includes(id));
  return entry ? entry.ids : [id];
}
