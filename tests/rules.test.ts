import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractWithRules,
  normalizeText,
  parseDeadline,
  parseSalary,
  toEndOfDayIso,
} from '../src/lib/llm/rules.ts';

const SAMPLE_JD = `
某科技有限公司 招聘 后端开发工程师（校招，2027届）
工作地点：上海 / 杭州
薪资：15k-25k，14薪
学历要求：本科及以上
经验要求：1-3年
技能要求：Java、MySQL、Redis、Docker，有 Kubernetes 经验优先
截止时间：2026年11月20日
`;

test('normalizeText：全角转半角并压空白', () => {
  assert.equal(normalizeText('ＡＢＣ　１２３'), 'ABC 123');
  assert.equal(normalizeText('a  \t b'), 'a b');
});

test('parseSalary（k 区间）：15k-25k + 14薪', () => {
  const parsed = parseSalary('薪资：15k-25k，14薪');
  assert.deepEqual(parsed, { salary_min: 15000, salary_max: 25000, salary_months: 14, evidence: '15k-25k' });
});

test('parseSalary（k 下限）：20k以上', () => {
  const parsed = parseSalary('月薪 20k以上');
  assert.equal(parsed?.salary_min, 20000);
  assert.equal(parsed?.salary_max, undefined);
});

test('parseSalary（年薪万）：20-35万/年 → 折算月薪', () => {
  const parsed = parseSalary('年薪 20-35万');
  assert.equal(parsed?.salary_min, Math.round(200000 / 12));
  assert.equal(parsed?.salary_max, Math.round(350000 / 12));
});

test('parseSalary（面议）：标注 negotiable', () => {
  const parsed = parseSalary('薪资面议');
  assert.equal(parsed?.salary_negotiable, true);
  assert.equal(parsed?.salary_min, undefined);
});

test('parseSalary（纯数字月薪）：15000-25000', () => {
  const parsed = parseSalary('月薪 15000-25000 元');
  assert.equal(parsed?.salary_min, 15000);
  assert.equal(parsed?.salary_max, 25000);
});

test('parseSalary：只有"N薪"时也能取到 salary_months', () => {
  const parsed = parseSalary('提供 13薪');
  assert.equal(parsed?.salary_months, 13);
  assert.equal(parsed?.salary_min, undefined);
});

test('parseSalary：无薪资信息返回 null', () => {
  assert.equal(parseSalary('我们提供良好的成长空间'), null);
});

test('parseDeadline：ISO 与中文日期都能解析，且统一到当日 23:59:59+08:00', () => {
  assert.deepEqual(parseDeadline('截止 2026-11-20'), {
    deadline: '2026-11-20T23:59:59+08:00',
    evidence: '2026-11-20',
  });
  assert.equal(parseDeadline('2026年11月20日截止')?.deadline, '2026-11-20T23:59:59+08:00');
  assert.equal(parseDeadline('2026/11/20')?.deadline, '2026-11-20T23:59:59+08:00');
});

test('parseDeadline：缺年份时按当前年补全', () => {
  const now = new Date('2026-10-16T00:00:00+08:00');
  const parsed = parseDeadline('请于11月20日前投递', now);
  assert.equal(parsed?.deadline, '2026-11-20T23:59:59+08:00');
});

test('parseDeadline：无日期返回 null', () => {
  assert.equal(parseDeadline('长期有效'), null);
});

test('toEndOfDayIso：补零正确', () => {
  assert.equal(toEndOfDayIso(2026, 1, 5), '2026-01-05T23:59:59+08:00');
});

test('extractWithRules（AC-6）：规则模式能抽出多个字段，且全部进入待确认', () => {
  const result = extractWithRules(SAMPLE_JD, new Date('2026-10-16T00:00:00+08:00'));

  assert.ok(result.matched >= 8, `命中字段过少：${result.matched}`);
  assert.equal(result.fields['title'], '后端开发工程师');
  assert.deepEqual(result.fields['cities'], ['上海', '杭州']);
  assert.equal(result.fields['salary_min'], 15000);
  assert.equal(result.fields['salary_max'], 25000);
  assert.equal(result.fields['education'], '本科');
  assert.equal(result.fields['job_type'], '校招');
  assert.equal(result.fields['graduation_year'], 2027);
  assert.deepEqual(result.fields['experience_years'], { min: 1, max: 3, unlimited: false });
  assert.equal(result.fields['deadline'], '2026-11-20T23:59:59+08:00');
  assert.ok(Array.isArray(result.fields['skills']));
  assert.ok((result.fields['skills'] as string[]).includes('Java'));
  assert.equal(result.fields['source'], 'manual');
  assert.equal(result.fields['raw_text'], SAMPLE_JD);

  // 规则模式的**抽取字段**置信度必须低于 0.7 阈值 → 全部待确认
  // （source / raw_text 是元数据，不参与阈值判定）
  for (const [id, conf] of Object.entries(result.confidence)) {
    if (id === 'source' || id === 'raw_text') continue;
    assert.ok(conf < 0.7, `${id} 置信度 ${conf} 应低于阈值`);
  }
  assert.ok(result.needsReview.includes('salary_min'));
  assert.ok(result.needsReview.includes('deadline'));
  assert.equal(result.needsReview.includes('raw_text'), false);
  assert.equal(result.needsReview.includes('source'), false);
});

test('extractWithRules：每命中字段都带 evidence（可追溯）', () => {
  const result = extractWithRules(SAMPLE_JD);
  for (const id of Object.keys(result.fields)) {
    if (id === 'raw_text' || id === 'source') continue;
    assert.ok(result.evidence[id], `${id} 缺少 evidence`);
  }
});

test('extractWithRules：完全无关文本不会崩溃，返回最小结果', () => {
  const result = extractWithRules('这是一段与招聘无关的文本。');
  assert.equal(typeof result.fields, 'object');
  assert.equal(result.fields['raw_text'], '这是一段与招聘无关的文本。');
  assert.ok(Array.isArray(result.needsReview));
});
