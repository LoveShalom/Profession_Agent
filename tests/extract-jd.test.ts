import test from 'node:test';
import assert from 'node:assert/strict';

import { generateEncryptionKey, validateEnv } from '../src/lib/env.ts';
import { buildExtractMessages, buildRuleExtraction, extractJd, loadExtractPrompt } from '../src/lib/llm/extract.ts';
import { createLLM } from '../src/lib/llm/index.ts';
import {
  PLACEHOLDER_COMPANY,
  PLACEHOLDER_TITLE,
  describeBlockers,
  validateExtraction,
} from '../src/lib/pipeline/validate.ts';
import { JdExtractionSchema, JdFieldsSchema, type JdExtraction } from '../src/lib/schemas/jd.ts';

const NOW = new Date('2026-10-23T10:00:00+08:00');

const JD = `某科技有限公司 招聘 后端开发工程师（2027届校招）
工作地点：上海 / 杭州
薪资：15k-25k，14薪
学历要求：本科及以上
技能要求：必须精通 Java，熟悉 MySQL；具备 Kubernetes 经验优先
截止时间：2026年11月20日
联系人：hr@example.com`;

const JD_NO_DEADLINE = `某科技有限公司 招聘 数据开发工程师（2027届校招）
工作地点：北京 / 上海可选
薪资：面议
学历要求：本科及以上
技能要求：熟悉 Python 与 SQL，了解 Spark；具备大数据平台经验优先
岗位职责：负责数据仓库建设、ETL 流程开发与数据质量监控，参与数据平台架构设计`;

// ---------------------------------------------------------------- Prompt（T4）
test('loadExtractPrompt：读到真实 prompt 并包含关键约束', () => {
  const prompt = loadExtractPrompt();
  assert.ok(prompt.length > 400, 'prompt 不应退化成兜底');
  for (const marker of ['<jd>', 'evidence', 'basisPhrase', 'provided', 'absent', 'inferred', '不要编造']) {
    assert.ok(prompt.includes(marker), `prompt 缺少关键约束：${marker}`);
  }
});

test('buildExtractMessages：system=prompt，user 用 <jd> 隔离原文', () => {
  const messages = buildExtractMessages({
    text: '一段 JD',
    segments: ['一段 JD'],
    language: 'zh',
    charCount: 4,
    piiFlags: [],
    injectionDetected: false,
    warnings: [],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[1]?.role, 'user');
  // 图片输入（F-04）引入后 content 可能是 parts 数组；文本抽取必须仍是纯字符串
  const userContent = messages[1]?.content;
  assert.equal(typeof userContent, 'string');
  assert.ok((userContent as string).startsWith('<jd>\n'));
  assert.ok((userContent as string).endsWith('\n</jd>'));
});

// ---------------------------------------------------------------- 规则抽取（L3/L4）
test('buildRuleExtraction：产出合法且字段正确的抽取结果', () => {
  const { extraction, deadline } = buildRuleExtraction(
    {
      ...{ text: JD, segments: [JD], language: 'zh', charCount: JD.length, piiFlags: [], injectionDetected: false, warnings: [] },
    },
    NOW,
  );

  assert.equal(JdExtractionSchema.safeParse(extraction).success, true, '规则结果必须满足 schema');
  assert.equal(JdFieldsSchema.safeParse(extraction.fields).success, true);

  assert.equal(extraction.fields.company, '某科技有限公司');
  assert.equal(extraction.fields.title, '后端开发工程师');
  assert.deepEqual(extraction.fields.cities, ['上海', '杭州']);
  assert.equal(extraction.fields.salary_min, 15000);
  assert.equal(extraction.fields.salary_max, 25000);
  assert.equal(extraction.fields.salary_months, 14);
  assert.equal(extraction.fields.deadline.kind, 'provided');
  assert.equal(extraction.fields.deadline.at, '2026-11-20T23:59:59+08:00');
  assert.equal(deadline.deadline.kind, 'provided');

  const java = extraction.fields.skills.find((s) => s.name === 'Java');
  assert.equal(java?.proficiency, 'expert');
  assert.equal(java?.requirement, 'must');
  assert.ok(extraction.needsReview.length > 0, '规则模式默认大部分字段待确认');
});

test('buildRuleExtraction：无截止日期 → absent，不产生 deadline 置信度', () => {
  const { extraction, deadline } = buildRuleExtraction(
    { text: JD_NO_DEADLINE, segments: [JD_NO_DEADLINE], language: 'zh', charCount: JD_NO_DEADLINE.length, piiFlags: [], injectionDetected: false, warnings: [] },
    NOW,
  );
  assert.equal(deadline.deadline.kind, 'absent');
  assert.equal(extraction.fields.deadline.kind, 'absent');
  assert.equal(extraction.confidence.deadline, undefined);
  assert.equal(extraction.evidence.deadline, undefined);
});

// ---------------------------------------------------------------- 校验（T7）
test('validateExtraction：占位公司/岗位 → blocker，不可入库', () => {
  const base = JdExtractionSchema.parse({
    fields: {
      company: PLACEHOLDER_COMPANY,
      title: PLACEHOLDER_TITLE,
      cities: [],
      source: 'manual',
      raw_text: 'x',
      deadline: { kind: 'absent', at: null, text: null },
    },
  });
  const result = validateExtraction(base);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('company_missing'));
  assert.ok(result.blockers.includes('title_missing'));
});

test('validateExtraction：薪资有值却无证据 → blocker', () => {
  const extraction = JdExtractionSchema.parse({
    fields: {
      company: '某公司',
      title: '某岗位',
      cities: ['北京'],
      source: 'manual',
      raw_text: 'x',
      salary_min: 15000,
      deadline: { kind: 'absent', at: null, text: null },
    },
  });
  const result = validateExtraction(extraction);
  assert.ok(result.blockers.includes('salary_evidence_missing'));
});

test('validateExtraction：截止时间三态豁免（R-3）', () => {
  const make = (deadline: unknown, evidence: Record<string, string | null>) =>
    JdExtractionSchema.parse({
      fields: { company: '某公司', title: '某岗位', cities: ['北京'], source: 'manual', raw_text: 'x', deadline },
      evidence,
    });

  // absent / text_only 不阻塞、不要求确认
  const absent = validateExtraction(
    make({ kind: 'absent', at: null, text: null }, {}),
  );
  assert.equal(absent.blockers.includes('deadline_evidence_missing'), false);
  assert.equal(absent.needsReview.includes('deadline'), false);

  const textOnly = validateExtraction(make({ kind: 'text_only', at: null, text: '招满为止' }, {}));
  assert.equal(textOnly.blockers.includes('deadline_evidence_missing'), false);
  assert.equal(textOnly.needsReview.includes('deadline'), false);

  // provided 但无证据 → 阻塞
  const providedNoEvidence = validateExtraction(
    make({ kind: 'provided', at: '2026-11-20T23:59:59+08:00', text: null }, {}),
  );
  assert.ok(providedNoEvidence.blockers.includes('deadline_evidence_missing'));

  // provided 有证据 → 不阻塞（但仍进 needsReview，因为属人工确认字段）
  const providedWithEvidence = validateExtraction(
    make({ kind: 'provided', at: '2026-11-20T23:59:59+08:00', text: null }, { deadline: '11月20日前' }),
  );
  assert.equal(providedWithEvidence.blockers.includes('deadline_evidence_missing'), false);
  assert.ok(providedWithEvidence.needsReview.includes('deadline'));
});

test('validateExtraction：低置信度进 needsReview，高置信度不进（非人工确认字段）', () => {
  const extraction = JdExtractionSchema.parse({
    fields: { company: '某公司', title: '某岗位', cities: ['北京'], source: 'manual', raw_text: 'x', deadline: { kind: 'absent', at: null, text: null } },
    confidence: { company: 0.95, title: 0.4, cities: 0.9 },
  });
  const result = validateExtraction(extraction);
  assert.equal(result.needsReview.includes('company'), false);
  assert.ok(result.needsReview.includes('title'), '0.4 < 0.7 应待确认');
  assert.equal(result.needsReview.includes('cities'), false);
});

test('describeBlockers：给出可操作的中文文案', () => {
  const messages = describeBlockers(['company_missing', 'deadline_evidence_missing']);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((m) => m.length > 4));
});

// ---------------------------------------------------------------- 编排（T5）
test('extractJd：无 service → 规则模式，结果合法且可入库', async () => {
  const result = await extractJd({ rawText: JD, now: NOW });

  assert.equal(result.level, null);
  assert.equal(result.path, 'rules');
  assert.equal(result.degraded, false);
  assert.ok(result.banner?.includes('规则模式'));
  assert.equal(result.ok, true, `阻塞项：${JSON.stringify(result.validation.blockers)}`);
  assert.equal(result.extraction.fields.company, '某科技有限公司');
  assert.equal(result.extraction.fields.deadline.kind, 'provided');
  assert.ok(result.clean.charCount > 0);
});

test('extractJd：空输入 → E_EMPTY 且不可入库', async () => {
  const result = await extractJd({ rawText: '   ', now: NOW });
  assert.ok(result.errors.includes('E_EMPTY'));
  assert.equal(result.ok, false);
  assert.equal(result.clean.segments.length, 0);
});

test('extractJd：极短文本 → E_NOT_JD（但允许强制入库）', async () => {
  const result = await extractJd({ rawText: '招聘 Java 工程师', now: NOW });
  assert.ok(result.errors.includes('E_NOT_JD'));
  assert.ok(result.extraction.fields.raw_text.length > 0, '仍应返回结果供用户确认');
});

test('extractJd：无截止日期的 JD 不被阻塞（R-3 核心场景）', async () => {
  const result = await extractJd({ rawText: JD_NO_DEADLINE, now: NOW });
  assert.equal(result.extraction.fields.deadline.kind, 'absent');
  assert.equal(result.validation.blockers.includes('deadline_evidence_missing'), false);
  assert.equal(result.validation.needsReview.includes('deadline'), false);
  // 面议 + 无证据：规则抽取到"面议"会带证据；此处至少不应因截止时间被阻塞
  assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------- 与模型串联（L0 / L3）
const KEY = generateEncryptionKey();

function makeEnv(overrides: Record<string, string> = {}) {
  const result = validateEnv({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres',
    ENCRYPTION_KEY: KEY,
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: 'sk-test',
    ...overrides,
  });
  assert.equal(result.ok, true);
  return result.env!;
}

const llmPayload = {
  fields: {
    company: '字节跳动',
    title: '后端工程师',
    cities: ['北京'],
    source: 'manual',
    raw_text: '（模型篡改的原文）',
    skills: [
      { name: 'Java', source: 'explicit', requirement: 'must', proficiency: 'expert', confidence: 0.9, basisPhrase: '精通 Java' },
    ],
    deadline: { kind: 'provided', at: '2026-12-01T23:59:59+08:00', text: '12月1日前' },
  },
  evidence: { company: '字节跳动', deadline: '12月1日前', salary_min: '15k-25k' },
  confidence: { company: 0.95, title: 0.9, cities: 0.9, salary_min: 0.9, skills: 0.9, deadline: 0.9 },
  needsReview: [],
};

const toolCallResponse = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(llmPayload) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200 },
  );

test('extractJd：有 Key 且模型可用 → L0，采用模型结果但原文以系统为准', async () => {
  const service = createLLM(makeEnv(), {
    skipProbe: true,
    fetchImpl: async () => toolCallResponse(),
  });

  const result = await extractJd({ rawText: JD, now: NOW }, { service });

  assert.equal(result.level, 'L0');
  assert.equal(result.path, 'tool_calling');
  assert.equal(result.degraded, false);
  assert.equal(result.extraction.fields.company, '字节跳动', '应采用模型抽取结果');
  assert.equal(result.extraction.fields.deadline.at, '2026-12-01T23:59:59+08:00');
  assert.equal(result.extraction.fields.raw_text, result.clean.text, '原文永不信任模型返回值');
  assert.notEqual(result.extraction.fields.raw_text, '（模型篡改的原文）');

  // 模型给了高置信的字段不应被拖进待确认（不能与规则模式的"全部待确认"做并集）
  assert.equal(result.validation.needsReview.includes('company'), false);
  assert.equal(result.validation.needsReview.includes('title'), false);
  assert.equal(result.validation.needsReview.includes('cities'), false);
  // 模型漏抽、规则抽到的字段要补进来（带证据 → 低置信 → 待确认），不能静默丢数据
  assert.equal(result.extraction.fields.salary_min, 15000, '模型未返回薪资时应由规则补齐');
  // 关键字段仍必须人工确认（G-01 / tech_stack §5）
  assert.ok(result.validation.needsReview.includes('salary_min'));
  assert.ok(result.validation.needsReview.includes('deadline'));
});

test('mergeExtraction：模型声称 provided 却无证据 → 回退规则判定，置信度也换成规则的', async () => {
  // 删掉 evidence.deadline，模拟"模型编造了日期但拿不出原文"
  const tampered = { ...llmPayload, evidence: { company: '字节跳动', salary_min: '15k-25k' } };
  const service = createLLM(makeEnv(), {
    skipProbe: true,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(tampered) } }] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      ),
  });

  const result = await extractJd({ rawText: JD, now: NOW }, { service });
  assert.equal(result.extraction.fields.deadline.kind, 'provided');
  assert.equal(result.extraction.fields.deadline.at, '2026-11-20T23:59:59+08:00', '应回退到规则解析的日期');
  assert.ok(result.extraction.evidence.deadline, '回退后必须带上规则的原文证据');
  assert.ok((result.extraction.confidence.deadline ?? 1) < 0.7, '回退字段的置信度应来自规则（低）');
});

test('loadExtractPrompt：明确要求推测技能名必须是具体技术名', () => {
  const prompt = loadExtractPrompt();
  assert.ok(prompt.includes('必须是具体技术名'), '需约束推测技能不得输出领域词本身');
});

test('extractJd：模型 500 → 降级到 L3 规则结果，不白屏', async () => {
  const service = createLLM(makeEnv(), {
    skipProbe: true,
    fetchImpl: async () => new Response('{"error":"upstream boom"}', { status: 500 }),
  });

  const result = await extractJd({ rawText: JD, now: NOW }, { service });

  assert.equal(result.level, 'L3');
  assert.equal(result.degraded, true);
  assert.ok(result.banner, '降级要给出横幅文案');
  assert.equal(result.extraction.fields.company, '某科技有限公司', '应回退到规则抽取结果');
  assert.equal(JdExtractionSchema.safeParse(result.extraction).success, true);
});

test('extractJd：source/sourceUrl 会写入结果且被校验接受', async () => {
  const result = await extractJd({ rawText: JD, source: 'plugin', sourceUrl: 'https://example.com/job/1', now: NOW });
  assert.equal(result.extraction.fields.source, 'plugin');
  assert.equal(result.extraction.fields.source_url, 'https://example.com/job/1');
});

test('extractJd：结果满足 schema 且 needsReview 与 validation 一致', async () => {
  const result = await extractJd({ rawText: JD, now: NOW });
  const parsed = JdExtractionSchema.parse(result.extraction);
  assert.deepEqual(new Set(parsed.needsReview), new Set(result.extraction.needsReview));
  assert.equal(result.validation.ok, result.validation.blockers.length === 0);
  const all: JdExtraction = result.extraction;
  assert.ok(all.fields.skills.length > 0, '规则模式也应抽出结构化技能');
});
