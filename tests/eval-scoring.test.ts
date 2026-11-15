import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, normalizeCompany, scoreItem, setF1, type GoldLikely, type PredLike } from '../src/lib/eval/scoring.ts';

const gold = (overrides: Partial<GoldLikely> = {}): GoldLikely => ({
  company: '星辰科技',
  title: '后端开发工程师',
  cities: ['上海'],
  deadline_kind: 'provided',
  deadline_at: '2026-12-31T23:59:59+08:00',
  salary_min: 20,
  salary_max: 30,
  skills: ['Java', 'MySQL'],
  ...overrides,
});

const pred = (overrides: Partial<PredLike> = {}): PredLike => ({ ...gold(), ...overrides });

test('全对：每个字段 1 分、macro=1', () => {
  const score = scoreItem(gold(), pred());
  assert.equal(score.macro, 1);
  assert.deepEqual(Object.values(score.perField), [1, 1, 1, 1, 1, 1]);
});

test('公司名归一：后缀差异与空格括号不影响判定', () => {
  assert.equal(normalizeCompany('星辰科技有限公司'), normalizeCompany('星辰科技'));
  assert.equal(scoreItem(gold(), pred({ company: '星辰科技有限公司' })).perField.company, 1);
  assert.equal(scoreItem(gold(), pred({ company: '云图数据' })).perField.company, 0);
});

test('城市用 set F1：漏一个不归零', () => {
  // F1 = 2·(P·R)/(P+R)：命中 1 个、gold 2 个、pred 1 个 → P=0.5、R=0.5 → F1=0.5
  assert.equal(setF1(['上海', '北京'], ['上海']), 0.5);
  assert.equal(scoreItem(gold({ cities: ['上海', '北京'] }), pred({ cities: ['上海'] })).perField.cities, 0.5);
  assert.equal(scoreItem(gold(), pred({ cities: [] })).perField.cities, 0);
});

test('截止日期：kind 必须一致；provided 时比日期', () => {
  assert.equal(scoreItem(gold(), pred({ deadline_kind: 'absent', deadline_at: null })).perField.deadline, 0);
  assert.equal(scoreItem(gold(), pred({ deadline_at: '2026-12-30T23:59:59+08:00' })).perField.deadline, 0);
  assert.equal(
    scoreItem(gold({ deadline_kind: 'text_only', deadline_at: null }), pred({ deadline_kind: 'text_only', deadline_at: null }))
      .perField.deadline,
    1,
  );
});

test('薪资：允许 1K 误差；gold 为空则不计分', () => {
  assert.equal(scoreItem(gold(), pred({ salary_min: 21, salary_max: 29 })).perField.salary, 1);
  assert.equal(scoreItem(gold(), pred({ salary_min: 25 })).perField.salary, 0);
  assert.equal(scoreItem(gold({ salary_min: null, salary_max: null }), pred({ salary_min: null, salary_max: null })).perField.salary, null);
});

test('技能：包含关系算命中，漏一个部分得分', () => {
  // gold 2 个、pred 3 个、命中 2 → P=2/3、R=1 → F1=0.8
  assert.equal(scoreItem(gold(), pred({ skills: ['Java', 'MySQL', 'Redis'] })).perField.skills, 0.8);
  assert.equal(scoreItem(gold(), pred({ skills: ['Java 开发', 'MySQL'] })).perField.skills, 1);
  assert.equal(scoreItem(gold({ skills: [] }), pred({ skills: ['Java'] })).perField.skills, null);
});

test('aggregate：按字段求均值，跳过不适用字段', () => {
  const result = aggregate([
    scoreItem(gold(), pred()),
    scoreItem(gold({ skills: [] }), pred({ company: '云图数据', skills: [] })),
  ]);
  assert.equal(result.items, 2);
  assert.equal(result.perField.company.evaluated, 2);
  assert.equal(result.perField.company.perfect, 1);
  assert.equal(result.perField.skills.evaluated, 1, 'gold 技能为空的那条不计入技能分');
  // 第二条：company=0、title=1、cities=1、deadline=1、salary=1（skills 不适用）→ macro=0.8
  assert.equal(Math.round(result.macro * 100) / 100, 0.9, '两条 macro 均值 = (1 + 0.8) / 2 = 0.9');
});
