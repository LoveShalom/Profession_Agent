import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELD_DICT_V1,
  FIELD_IDS,
  FIELD_NUMBERS,
  MANUAL_CONFIRM_FIELD_IDS,
  REQUIRED_FIELD_IDS,
  fieldLabel,
  isFieldId,
  siblingFieldIds,
} from '../src/lib/schemas/field-dict.ts';
import {
  ABSENT_DEADLINE,
  DEADLINE_KIND_VALUES,
  JD_EXTRACTION_JSON_SCHEMA,
  JD_FIELDS_JSON_SCHEMA,
  JdExtractionSchema,
  JdFieldsSchema,
  SKILL_PROFICIENCY_VALUES,
  SKILL_REQUIREMENT_VALUES,
  SKILL_SOURCE_VALUES,
  jdExtractionSchemaLike,
  splitSkillColumns,
} from '../src/lib/schemas/jd.ts';
import type { SkillItem } from '../src/lib/schemas/jd.ts';

// ---------------------------------------------------------------- 夹具
const skill = (overrides: Partial<SkillItem> = {}): SkillItem => ({
  name: 'Java',
  source: 'explicit',
  requirement: 'must',
  proficiency: 'expert',
  confidence: 0.9,
  basisPhrase: '精通 Java',
  ...overrides,
});

/** 故意构造非法数据时用它（绕过 TS 的枚举检查，验证运行期确实拒绝） */
const skillRaw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ ...skill(), ...overrides });

const fields = (overrides: Record<string, unknown> = {}) => ({
  company: '某科技有限公司',
  title: '后端开发工程师',
  cities: ['上海'],
  source: 'manual',
  raw_text: '某科技有限公司招聘后端开发工程师，要求精通 Java，薪资 15k-25k。',
  ...overrides,
});

const validExtraction = () => ({
  fields: fields({ skills: [skill()], deadline: ABSENT_DEADLINE }),
  evidence: { company: '某科技有限公司', title: '后端开发工程师', salary_min: '15k-25k' },
  confidence: { company: 0.95, title: 0.9, salary_min: 0.8 },
  needsReview: ['salary_min', 'salary_max'],
});

// ---------------------------------------------------------------- 字段字典
test('字段字典：18 个编号连续、21 个字段值、无重复', () => {
  assert.deepEqual(FIELD_NUMBERS, Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(FIELD_IDS.length, 21);
  assert.equal(new Set(FIELD_IDS).size, 21, '字段 id 不可重复');
  assert.equal(FIELD_DICT_V1.length, 18);
});

test('字段字典：必填与人工确认集合与规范一致（G-01）', () => {
  assert.deepEqual([...REQUIRED_FIELD_IDS], ['company', 'title', 'cities', 'source', 'raw_text']);
  assert.deepEqual([...MANUAL_CONFIRM_FIELD_IDS], ['salary_min', 'salary_max', 'salary_negotiable', 'deadline']);
});

test('字段字典：查询工具（isFieldId / fieldLabel / siblingFieldIds）', () => {
  assert.equal(isFieldId('company'), true);
  assert.equal(isFieldId('nonexistent'), false);
  assert.equal(fieldLabel('salary_min'), '薪资区间');
  assert.equal(fieldLabel('deadline'), '截止时间');
  // 组合字段：评测按 18 个编号统计，组合字段整组正确才算对（G-02）
  assert.deepEqual([...siblingFieldIds('salary_max')], ['salary_min', 'salary_max']);
  assert.deepEqual([...siblingFieldIds('company')], ['company']);
});

// ---------------------------------------------------------------- 字段校验
test('JdFieldsSchema：最小必填集可通过，可选字段套用默认值', () => {
  const parsed = JdFieldsSchema.parse(fields());
  assert.equal(parsed.job_type, '未知');
  assert.equal(parsed.education, '未知');
  assert.equal(parsed.work_mode, '未知');
  assert.equal(parsed.salary_negotiable, false);
  assert.deepEqual(parsed.skills, []);
  assert.equal(parsed.deadline.kind, 'absent', '未给截止日期时默认 absent（R-3：不是错误）');
  assert.equal(parsed.deadline.at, null);
});

test('JdFieldsSchema：缺少必填字段时报错', () => {
  assert.equal(JdFieldsSchema.safeParse({ ...fields(), company: undefined }).success, false);
  assert.equal(JdFieldsSchema.safeParse({ ...fields(), raw_text: '' }).success, false);
});

test('JdFieldsSchema（G-02 组合字段）：薪资上限小于下限 → 报错', () => {
  const result = JdFieldsSchema.safeParse(fields({ salary_min: 25000, salary_max: 15000 }));
  assert.equal(result.success, false);
  assert.ok(!result.success && result.error.issues.some((i) => i.path.includes('salary_max')));
});

test('JdFieldsSchema（字典 #9）：面议时 min/max 必须为空', () => {
  assert.equal(JdFieldsSchema.safeParse(fields({ salary_negotiable: true })).success, true);
  const bad = JdFieldsSchema.safeParse(fields({ salary_negotiable: true, salary_min: 15000 }));
  assert.equal(bad.success, false);
});

test('JdFieldsSchema：技能去重（同 source + 同名）与推测技能必须有依据', () => {
  const dup = JdFieldsSchema.safeParse(fields({ skills: [skill(), skill()] }));
  assert.equal(dup.success, false, '同 (source,name) 不允许重复');

  // 同名但来源不同是允许的（明确 + 推测）
  const bothSources = JdFieldsSchema.safeParse(
    fields({ skills: [skill(), skill({ source: 'inferred', proficiency: 'unknown', basisPhrase: '后端开发' })] }),
  );
  assert.equal(bothSources.success, true);

  const noBasis = JdFieldsSchema.safeParse(fields({ skills: [skill({ basisPhrase: '' })] }));
  assert.equal(noBasis.success, false, 'basisPhrase 是强制项（幻觉抑制）');
});

test('SkillItem：枚举与置信度边界', () => {
  assert.equal(JdFieldsSchema.safeParse(fields({ skills: [skillRaw({ source: 'guessed' })] })).success, false);
  assert.equal(JdFieldsSchema.safeParse(fields({ skills: [skillRaw({ proficiency: 'master' })] })).success, false);
  assert.equal(JdFieldsSchema.safeParse(fields({ skills: [skillRaw({ confidence: 1.5 })] })).success, false);
});

// ---------------------------------------------------------------- 截止时间三态（R-3）
test('Deadline 三态：三种合法形态', () => {
  const ok = [
    { kind: 'provided', at: '2026-11-20T23:59:59+08:00', text: '11月20日前' },
    { kind: 'text_only', at: null, text: '招满为止' },
    { kind: 'absent', at: null, text: null },
  ];
  for (const deadline of ok) {
    assert.equal(JdFieldsSchema.safeParse(fields({ deadline })).success, true, `应接受 ${deadline.kind}`);
  }
});

test('Deadline 三态：非法组合被拒绝（防"JD 没写却编造日期"）', () => {
  const bad = [
    { kind: 'provided', at: null, text: '11月20日前' },
    { kind: 'text_only', at: null, text: null },
    { kind: 'absent', at: '2026-11-20T23:59:59+08:00', text: null },
  ];
  for (const deadline of bad) {
    assert.equal(JdFieldsSchema.safeParse(fields({ deadline })).success, false, `应拒绝 ${JSON.stringify(deadline)}`);
  }
});

test('ABSENT_DEADLINE 可直接使用（无截止日期是合法状态）', () => {
  assert.deepEqual(ABSENT_DEADLINE, { kind: 'absent', at: null, text: null });
  assert.equal(JdFieldsSchema.safeParse(fields({ deadline: ABSENT_DEADLINE })).success, true);
});

// ---------------------------------------------------------------- 抽取信封
test('JdExtractionSchema：信封缺省 evidence/confidence/needsReview 时可用', () => {
  const parsed = JdExtractionSchema.parse({ fields: fields({ skills: [skill()] }) });
  assert.deepEqual(parsed.evidence, {});
  assert.deepEqual(parsed.confidence, {});
  assert.deepEqual(parsed.needsReview, []);
});

test('JdExtractionSchema：evidence 出现未知字段名 → 报错', () => {
  const result = JdExtractionSchema.safeParse({
    ...validExtraction(),
    evidence: { company: 'x', not_a_field: 'y' },
  });
  assert.equal(result.success, false);
});

test('JdExtractionSchema：置信度必须在 0–1', () => {
  assert.equal(JdExtractionSchema.safeParse({ ...validExtraction(), confidence: { company: 1.2 } }).success, false);
});

test('JdExtractionSchema：合法样本可通过', () => {
  const parsed = JdExtractionSchema.parse(validExtraction());
  assert.equal(parsed.fields.company, '某科技有限公司');
  assert.equal(parsed.fields.skills[0]?.name, 'Java');
  assert.deepEqual(parsed.needsReview, ['salary_min', 'salary_max']);
});

// ---------------------------------------------------------------- JSON Schema ↔ Zod 一致性
test('JSON Schema：覆盖全部 21 个字段、枚举与 Zod 一致', () => {
  const properties = JD_FIELDS_JSON_SCHEMA.properties as Record<string, unknown>;
  for (const id of FIELD_IDS) {
    assert.ok(id in properties, `JSON Schema 缺少字段 ${id}`);
  }
  const deadlineProps = (
    JD_FIELDS_JSON_SCHEMA.properties.deadline as { properties: Record<string, { enum?: readonly string[] }> }
  ).properties;
  assert.deepEqual(deadlineProps.kind?.enum, [...DEADLINE_KIND_VALUES]);

  const skillProps = (
    JD_FIELDS_JSON_SCHEMA.properties.skills as {
      items: { properties: Record<string, { enum?: readonly string[] }>; required: readonly string[] };
    }
  ).items;
  assert.deepEqual(skillProps.properties.source?.enum, [...SKILL_SOURCE_VALUES]);
  assert.deepEqual(skillProps.properties.requirement?.enum, [...SKILL_REQUIREMENT_VALUES]);
  assert.deepEqual(skillProps.properties.proficiency?.enum, [...SKILL_PROFICIENCY_VALUES]);
  assert.deepEqual([...skillProps.required].sort(), ['basisPhrase', 'confidence', 'name', 'proficiency', 'requirement', 'source']);
  assert.equal((JD_EXTRACTION_JSON_SCHEMA as { additionalProperties: boolean }).additionalProperties, false);
});

test('JSON Schema 会被 LLM 输入的常见偏差拒绝（ajv 校验，若可用）', async () => {
  let Ajv: unknown;
  try {
    const mod = (await import('ajv')) as { default?: unknown };
    Ajv = mod.default ?? mod;
  } catch {
    return; // ajv 不可用（如未装依赖）时跳过，不影响其他断言
  }
  const create = Ajv as new (
    opts?: Record<string, unknown>,
  ) => { compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown } };
  const ajv = new create({ allErrors: true, strict: false });
  const validate = ajv.compile(JD_EXTRACTION_JSON_SCHEMA);

  // 合法样本在 JSON Schema 与 Zod 两边都通过
  const sample = JSON.parse(JSON.stringify(validExtraction()));
  assert.equal(validate(sample), true, `JSON Schema 应接受合法样本：${JSON.stringify(validate.errors)}`);
  assert.equal(JdExtractionSchema.safeParse(sample).success, true);

  // 非法样本在两边都拒绝
  const badSkill = JSON.parse(JSON.stringify(validExtraction()));
  badSkill.fields.skills[0].proficiency = 'master';
  assert.equal(validate(badSkill), false, 'JSON Schema 应拒绝非法熟练度');
  assert.equal(JdExtractionSchema.safeParse(badSkill).success, false, 'Zod 应拒绝非法熟练度');
});

// ---------------------------------------------------------------- SchemaLike 适配（F-01 契约）
test('jdExtractionSchemaLike：满足 F-01 的 SchemaLike 契约', () => {
  assert.equal(typeof jdExtractionSchemaLike.parse, 'function');
  assert.equal(typeof jdExtractionSchemaLike.safeParse, 'function');
  assert.equal(typeof jdExtractionSchemaLike.describe, 'function');
  assert.ok(jdExtractionSchemaLike.jsonSchema, '必须提供 jsonSchema 供 tool calling');

  const okResult = jdExtractionSchemaLike.safeParse(validExtraction());
  assert.equal(okResult.success, true);

  const badResult = jdExtractionSchemaLike.safeParse({ fields: {} });
  assert.equal(badResult.success, false);
  assert.ok(!badResult.success && badResult.error.length > 0, '失败时返回可读错误串（供修复重试）');
  assert.ok(!badResult.success && /company/.test(badResult.error), '错误串应包含字段路径');

  const description = jdExtractionSchemaLike.describe?.() ?? '';
  assert.ok(description.includes('evidence'), '描述里要交代 evidence 要求');
  assert.ok(description.includes('absent'), '描述里要交代截止时间三态');
});

// ---------------------------------------------------------------- 技能分列（R-5）
test('splitSkillColumns：三列互斥且格式符合约定', () => {
  const columns = splitSkillColumns([
    skill({ name: 'Java', requirement: 'must', proficiency: 'expert' }),
    skill({ name: 'MySQL', requirement: 'must', proficiency: 'proficient' }),
    skill({ name: 'Kubernetes', requirement: 'nice_to_have', proficiency: 'familiar' }),
    skill({ name: 'Go', requirement: 'unknown', proficiency: 'unknown' }),
    skill({ name: 'TensorFlow', source: 'inferred', proficiency: 'unknown', confidence: 0.4, basisPhrase: '深度学习' }),
  ]);

  assert.equal(columns.explicitMust, 'Java(精通);MySQL(熟练)');
  assert.equal(columns.explicitNice, 'Kubernetes(熟悉);Go', 'requirement=unknown 归入加分列');
  assert.equal(columns.inferred, 'TensorFlow(0.4←"深度学习")');
  // 三列互斥：同一技能名不出现在两列里
  for (const name of ['Java', 'MySQL', 'Kubernetes', 'Go', 'TensorFlow']) {
    const hits: number = [columns.explicitMust, columns.explicitNice, columns.inferred].filter((col) =>
      col.includes(name),
    ).length;
    assert.equal(hits, 1, `${name} 只应出现在一列`);
  }
});
