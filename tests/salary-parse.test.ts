import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSalary } from '../src/lib/llm/rules.ts';

test('薪资：K/千 区间（两侧带单位）', () => {
  assert.deepEqual(
    parseSalary('薪资 15k-25k，14 薪'),
    { salary_min: 15000, salary_max: 25000, salary_months: 14, evidence: '15k-25k' },
  );
  assert.deepEqual(parseSalary('20K~30K'), {
    salary_min: 20000,
    salary_max: 30000,
    salary_months: undefined,
    evidence: '20K~30K',
  });
});

test('薪资回归：只有右侧带 K（"月薪 20-30K"）也必须识别', () => {
  const parsed = parseSalary('月薪 20-30K');
  assert.equal(parsed?.salary_min, 20000);
  assert.equal(parsed?.salary_max, 30000);
});

test('薪资回归：万默认按月薪（×10000），不当年薪÷12', () => {
  assert.equal(parseSalary('薪资 2-3 万')?.salary_min, 20000);
  assert.equal(parseSalary('薪资 2-3 万')?.salary_max, 30000);
  assert.equal(parseSalary('月薪 2.5 万')?.salary_min, 25000);
});

test('薪资：出现年化语境才 ÷12（年薪 30-36 万）', () => {
  assert.equal(parseSalary('年薪 30-36 万')?.salary_min, 25000);
  assert.equal(parseSalary('年包 36 万')?.salary_min, 30000);
  // 20 万/年 ÷ 12 ≈ 16667 元/月
  assert.equal(parseSalary('20-35万/年')?.salary_min, 16667);
});

test('薪资：单值 K、以上形式、纯数字、面议', () => {
  assert.equal(parseSalary('20k以上')?.salary_min, 20000);
  assert.deepEqual(parseSalary('15000-25000'), {
    salary_min: 15000,
    salary_max: 25000,
    salary_months: undefined,
    evidence: '15000-25000',
  });
  assert.deepEqual(parseSalary('薪资面议'), { salary_negotiable: true, evidence: '面议' });
  assert.equal(parseSalary('本岗位不写薪资'), null);
});

test('薪资：只有月数信息时返回 salary_months', () => {
  assert.deepEqual(parseSalary('14 薪'), { salary_months: 14, evidence: '14 薪' });
});
