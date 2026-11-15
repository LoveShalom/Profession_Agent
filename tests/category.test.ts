import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JOB_CATEGORIES,
  TIER_LABEL,
  categoryCodeFromCell,
  categoryLabel,
  categoryTier,
  deriveJobCategory,
  effectiveTier,
  parseTierCell,
  tierLabel,
} from '../src/lib/jobs/category.ts';

test('分类目录：code 唯一、label 非空', () => {
  const codes = JOB_CATEGORIES.map((category) => category.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(JOB_CATEGORIES.every((category) => category.label.length > 0));
});

test('医学影像：标题命中权重最高', () => {
  const match = deriveJobCategory({ title: '医学影像算法工程师', skills: ['Python'], rawText: '做影像分割' });
  assert.equal(match.code, 'algo-medical-imaging');
  assert.equal(match.label, '医学影像算法');
  assert.match(match.reason, /医学影像/);
});

test('大模型 vs CV：靠标题区分', () => {
  assert.equal(deriveJobCategory({ title: '大模型算法工程师（LLM 微调）' }).code, 'algo-llm');
  assert.equal(deriveJobCategory({ title: 'CV 算法工程师（目标检测）' }).code, 'algo-cv');
});

test('技能与原文也能提供证据（标题不明确时）', () => {
  const match = deriveJobCategory({
    title: '算法工程师',
    skills: ['PyTorch', '目标检测', 'BEV'],
    rawText: '负责 3D 检测与点云处理',
  });
  assert.equal(match.code, 'algo-cv');
});

test('后端 / 前端 / 数据 基本分流', () => {
  assert.equal(deriveJobCategory({ title: '后端开发工程师（Java）' }).code, 'backend');
  assert.equal(deriveJobCategory({ title: '前端开发工程师', skills: ['React', 'TypeScript'] }).code, 'frontend');
  assert.equal(deriveJobCategory({ title: '数据仓库工程师', skills: ['Spark', 'Hive'] }).code, 'data');
});

test('无命中 → other（不猜）', () => {
  const match = deriveJobCategory({ title: '岗位', rawText: '一段普通描述' });
  assert.equal(match.code, 'other');
  assert.equal(match.score, 0);
});

test('回归：短 ASCII 关键词不能子串误命中（CT 不应命中 react）', () => {
  const frontend = deriveJobCategory({ title: '前端开发工程师', skills: ['React', 'TypeScript'], rawText: '组件化开发' });
  assert.equal(frontend.code, 'frontend');
});

test('回归：单字关键词已移除（"电脑"不应命中医学影像）', () => {
  const ops = deriveJobCategory({ title: '运维工程师', skills: ['Linux'], rawText: '负责电脑与服务器维护' });
  assert.notEqual(ops.code, 'algo-medical-imaging');
});

test('回归：真正的医学影像仍识别（MRI / 脑影像）', () => {
  const match = deriveJobCategory({ title: '算法工程师', rawText: '基于 MRI 的脑影像分割与病灶检测' });
  assert.equal(match.code, 'algo-medical-imaging');
});

test('AI 应用（RAG/Agent/多模态）与 大模型算法（预训练/微调）分流', () => {
  const app = deriveJobCategory({ title: 'AI 应用工程师（RAG/Agent）', rawText: '构建知识库与智能体' });
  assert.equal(app.code, 'ai-app');
  assert.equal(app.tier, 'secondary');

  const llm = deriveJobCategory({ title: '大模型算法工程师（预训练/微调）' });
  assert.equal(llm.code, 'algo-llm');
  assert.equal(llm.tier, 'casual');
});

test('投递定位：医学影像=主投，CV/AI应用=副投，其余=碰运气', () => {
  assert.equal(tierLabel('algo-medical-imaging'), '主投');
  assert.equal(tierLabel('algo-cv'), '副投');
  assert.equal(tierLabel('ai-app'), '副投');
  assert.equal(tierLabel('backend'), '碰运气');
  assert.equal(tierLabel('other'), '碰运气');
  assert.equal(tierLabel(null), '碰运气');
  assert.equal(categoryTier('my-custom'), 'casual', '自定义分类不冒充主投');
  assert.equal(TIER_LABEL.primary, '主投');
});

test('台账单元格解析：中文标签 / code / 自定义 / 空', () => {
  assert.equal(categoryCodeFromCell('医学影像算法'), 'algo-medical-imaging');
  assert.equal(categoryCodeFromCell('CV 算法'), 'algo-cv');
  assert.equal(categoryCodeFromCell('algo-llm'), 'algo-llm');
  assert.equal(categoryCodeFromCell('我的自定义分类'), '我的自定义分类');
  assert.equal(categoryCodeFromCell('   '), null);
});

test('class=other 兜底仍在：分类目录最后一项是其他', () => {
  assert.equal(JOB_CATEGORIES[JOB_CATEGORIES.length - 1]!.code, 'other');
  assert.equal(JOB_CATEGORIES[JOB_CATEGORIES.length - 1]!.tier, 'casual');
});

test('手动覆盖定位：覆盖优先于分类派生；清空恢复跟随分类', () => {
  assert.deepEqual(effectiveTier('algo-medical-imaging', null), { tier: 'primary', label: '主投', overridden: false });
  assert.deepEqual(effectiveTier('algo-medical-imaging', 'casual'), { tier: 'casual', label: '碰运气', overridden: true });
  assert.deepEqual(effectiveTier('backend', 'primary'), { tier: 'primary', label: '主投', overridden: true });
  assert.deepEqual(effectiveTier('backend', undefined), { tier: 'casual', label: '碰运气', overridden: false });
  // 脏值：不认识的值当作"未覆盖"
  assert.deepEqual(effectiveTier('algo-cv', 'unknown'), { tier: 'secondary', label: '副投', overridden: false });
});

test('台账定位单元格解析：中文/英文/空', () => {
  assert.equal(parseTierCell('主投'), 'primary');
  assert.equal(parseTierCell('副投'), 'secondary');
  assert.equal(parseTierCell('碰运气'), 'casual');
  assert.equal(parseTierCell('primary'), 'primary');
  assert.equal(parseTierCell('   '), null);
  assert.equal(parseTierCell('乱写'), null);
});

test('categoryLabel：已知返回中文，未知原样返回（支持自定义分类）', () => {
  assert.equal(categoryLabel('algo-cv'), 'CV 算法');
  assert.equal(categoryLabel('my-custom'), 'my-custom');
  assert.equal(categoryLabel(null), '未分类');
});
