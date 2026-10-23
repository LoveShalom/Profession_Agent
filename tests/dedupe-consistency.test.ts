import test from 'node:test';
import assert from 'node:assert/strict';

import { generateEncryptionKey, validateEnv } from '../src/lib/env.ts';
import { extractJd } from '../src/lib/llm/extract.ts';
import { createLLM } from '../src/lib/llm/index.ts';
import {
  clampSampleK,
  computeConsistency,
  fieldValuesEqual,
  normalizeForCompare,
} from '../src/lib/pipeline/consistency.ts';
import {
  FINGERPRINT_VERSION,
  buildFingerprint,
  describeFingerprint,
  looksLikeSameJob,
  normalizeCompanyForFingerprint,
  normalizeTitleForFingerprint,
  shortFingerprint,
} from '../src/lib/pipeline/dedupe.ts';
import { ABSENT_DEADLINE, JdExtractionSchema, type JdExtraction } from '../src/lib/schemas/jd.ts';

// ════════════════════════════════════════════════ 指纹（T8 / G-06）
const job = (overrides: Partial<{ company: string; title: string; cities: string[] }> = {}) => ({
  company: '某科技有限公司',
  title: '后端开发工程师',
  cities: ['上海'],
  ...overrides,
});

test('指纹：法人后缀不影响结果（"某科技有限公司" = "某科技"）', () => {
  assert.equal(buildFingerprint(job()), buildFingerprint(job({ company: '某科技' })));
  assert.equal(normalizeCompanyForFingerprint('某科技有限公司'), '某科技');
  assert.equal(normalizeCompanyForFingerprint('某股份有限公司'), '某');
});

test('指纹：不误剥名字成分（"某科技" 与 "某集团" 仍是不同公司）', () => {
  const a = buildFingerprint(job({ company: '某科技' }));
  const b = buildFingerprint(job({ company: '某集团' }));
  assert.notEqual(a, b);
});

test('指纹：城市集合排序 + 别名归一（顺序与写法无关）', () => {
  const a = buildFingerprint(job({ cities: ['上海', '北京'] }));
  const b = buildFingerprint(job({ cities: ['北京', '上海'] }));
  const c = buildFingerprint(job({ cities: ['魔都', '帝都'] }));
  assert.equal(a, b);
  assert.equal(a, c);
});

test('指纹：城市不同 → 不同岗位（G-06 多城市视为不同记录）', () => {
  assert.notEqual(buildFingerprint(job({ cities: ['上海'] })), buildFingerprint(job({ cities: ['北京'] })));
});

test('指纹：岗位名的括号内容与招聘尾巴被忽略', () => {
  assert.equal(normalizeTitleForFingerprint('后端开发工程师（急招）'), '后端开发工程师');
  assert.equal(normalizeTitleForFingerprint('后端开发工程师【校招】'), '后端开发工程师');
  assert.equal(normalizeTitleForFingerprint('后端开发工程师 急招'), '后端开发工程师');
  assert.equal(buildFingerprint(job()), buildFingerprint(job({ title: '后端开发工程师（急招）' })));
});

test('指纹：全半角与空白差异被视为同一岗位', () => {
  assert.equal(buildFingerprint(job({ company: '某科技有限公司' })), buildFingerprint(job({ company: ' 某科技 有限公司 ' })));
  assert.equal(
    buildFingerprint(job({ title: 'Java 开发工程师' })),
    buildFingerprint(job({ title: 'Ｊａｖａ开发工程师' })),
  );
});

test('指纹：输出为 64 位十六进制，且带版本号（改规则必须升版本）', () => {
  const fingerprint = buildFingerprint(job());
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(FINGERPRINT_VERSION, 'fp-v1');
  assert.equal(shortFingerprint(fingerprint), fingerprint.slice(0, 8));
});

test('指纹：describeFingerprint 给出归一化三元组（可用于排查）', () => {
  const described = describeFingerprint({ company: '某科技有限公司', title: '后端开发工程师（急招）', cities: ['帝都', '上海'] });
  assert.deepEqual(described, { company: '某科技', title: '后端开发工程师', cities: ['上海', '北京'] });
});

test('looksLikeSameJob：同一岗位不同写法 → true', () => {
  assert.equal(looksLikeSameJob(job(), job({ company: '某科技', title: '后端开发工程师（急招）' })), true);
  assert.equal(looksLikeSameJob(job({ cities: ['上海', '北京'] }), job({ title: '后端开发工程师（急招）', cities: ['帝都', '魔都'] })), true);
  assert.equal(looksLikeSameJob(job(), job({ title: '前端开发工程师' })), false);
});

// ════════════════════════════════════════════════ 自一致性（T6 / A15）
const extractionOf = (company: string, extra: Partial<JdExtraction['fields']> = {}): JdExtraction =>
  JdExtractionSchema.parse({
    fields: {
      company,
      title: '后端开发工程师',
      cities: ['上海'],
      source: 'manual',
      raw_text: 'x',
      deadline: ABSENT_DEADLINE,
      ...extra,
    },
    confidence: { company: 0.9, title: 0.9 },
    needsReview: [],
  });

test('normalizeForCompare：空白/全半角/数组顺序/对象键顺序都不影响比较', () => {
  assert.equal(normalizeForCompare(' 某科技 '), normalizeForCompare('某科技'));
  assert.equal(normalizeForCompare('ＡＢＣ'), normalizeForCompare('ABC'));
  assert.equal(normalizeForCompare(['上海', '北京']), normalizeForCompare(['北京', '上海']));
  assert.equal(normalizeForCompare({ a: 1, b: 2 }), normalizeForCompare({ b: 2, a: 1 }));
  assert.equal(fieldValuesEqual(null, null), true);
});

test('computeConsistency：3 个完全一致的样本 → 一致率 1，置信度被覆盖为 1', () => {
  const result = computeConsistency([extractionOf('某科技'), extractionOf('某科技'), extractionOf('某科技')]);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.score, 1);
  assert.equal(result.agreement.company, 1);
  assert.equal(result.extraction.confidence.company, 1);
});

test('computeConsistency：2/3 一致 → 一致率 0.667，取众数，低于 0.7 会自动进待确认', () => {
  const result = computeConsistency([extractionOf('某科技'), extractionOf('某科技'), extractionOf('字节跳动')]);
  assert.equal(result.agreement.company, Number((2 / 3).toFixed(3)));
  assert.equal(result.extraction.fields.company, '某科技');
  assert.ok((result.extraction.confidence.company ?? 1) < 0.7, '0.667 < 0.7 → 应由 validate 判为待确认');
  assert.ok(result.score < 1 && result.score > 0.6);
});

test('computeConsistency：写法差异不算分歧（空白/全半角/数组顺序）', () => {
  const a = extractionOf('某科技', { cities: ['上海', '北京'] });
  const b = extractionOf(' 某科技 ', { cities: ['北京', '上海'] });
  const result = computeConsistency([a, b]);
  assert.equal(result.agreement.company, 1);
  assert.equal(result.agreement.cities, 1);
});

test('computeConsistency：任一样本要求复核的字段都会进入待确认（保守）', () => {
  const withReview = JdExtractionSchema.parse({
    fields: { company: '某科技', title: '后端开发工程师', cities: ['上海'], source: 'manual', raw_text: 'x', deadline: ABSENT_DEADLINE },
    needsReview: ['salary_min'],
  });
  const result = computeConsistency([extractionOf('某科技'), withReview]);
  assert.ok(result.extraction.needsReview.includes('salary_min'));
});

test('clampSampleK：夹到 1–5，非法值退回默认 3', () => {
  assert.equal(clampSampleK(1), 1);
  assert.equal(clampSampleK(3), 3);
  assert.equal(clampSampleK(9), 5);
  assert.equal(clampSampleK(0), 1);
  assert.equal(clampSampleK(undefined), 3);
  assert.equal(clampSampleK(Number.NaN), 3);
});

// ════════════════════════════════════════════════ 与 extractJd 串联
const KEY = generateEncryptionKey();
function makeEnv() {
  const result = validateEnv({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres',
    ENCRYPTION_KEY: KEY,
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: 'sk-test',
  });
  assert.equal(result.ok, true);
  return result.env!;
}

const samplePayload = (company: string) => ({
  fields: {
    company,
    title: '后端开发工程师',
    cities: ['上海'],
    source: 'manual',
    raw_text: '（模型原文）',
    skills: [],
    deadline: { kind: 'provided', at: '2026-11-20T23:59:59+08:00', text: '11月20日前' },
  },
  evidence: { company, deadline: '11月20日前' },
  confidence: { company: 0.95, title: 0.95, cities: 0.95, deadline: 0.95 },
  needsReview: [],
});

test('extractJd(sampleK=3)：采样 3 次 → 众数获胜 + 一致率写入置信度', async () => {
  const responses = ['某科技', '某科技', '字节跳动'];
  let call = 0;
  const service = createLLM(makeEnv(), {
    skipProbe: true,
    fetchImpl: async () => {
      const company = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(samplePayload(company)) } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    },
  });

  const result = await extractJd(
    {
      rawText:
        '某科技有限公司 招聘 后端开发工程师（2027届校招）\n工作地点：上海 / 杭州\n薪资：15k-25k\n学历要求：本科及以上\n' +
        '技能要求：熟悉 Java 与 MySQL，具备 Kubernetes 经验优先\n岗位职责：参与后端服务设计与开发，保障系统稳定性与性能\n截止时间：2026年11月20日',
      now: new Date('2026-10-23T10:00:00+08:00'),
    },
    { service, sampleK: 3 },
  );

  assert.equal(call, 3, '应采样 3 次');
  assert.equal(result.level, 'L0');
  assert.ok(result.consistency, 'K>1 时必须返回一致性汇总');
  assert.equal(result.consistency?.sampleCount, 3);
  assert.equal(result.extraction.fields.company, '某科技', '众数获胜');
  assert.equal(result.extraction.confidence.company, Number((2 / 3).toFixed(3)));
  assert.ok(result.validation.needsReview.includes('company'), '一致率 0.667 < 0.7 → 待确认');
});
