import test from 'node:test';
import assert from 'node:assert/strict';

import type { LLMService } from '../src/lib/llm/index.ts';
import {
  buildExperienceMessages,
  extractExperienceStructured,
  loadExperiencePrompt,
  mergeExperienceExtraction,
} from '../src/lib/llm/experience.ts';
import { extractExperienceFromText, normalizeSkills } from '../src/lib/pipeline/experience.ts';

const TEXT = [
  '在某某科技有限公司实习，担任后端开发实习生，时间 2026年6月到2026年9月。',
  '订单系统大促超时，我负责把 P99 降到 200ms 以内。',
  '重写查询、加 Redis 缓存、按用户分库分表。',
  '最终 P99 从 800ms 降到 180ms，吞吐提升 30%。',
].join('\n');

function fakeService(data: unknown, status: string = 'ok'): LLMService {
  return {
    hasCredential: true,
    run: async () => ({ status, data, level: 'L1', path: 'prompt_json', degraded: status !== 'ok' }),
  } as unknown as LLMService;
}

test('无模型：走规则切分并提示「规则模式」', async () => {
  const result = await extractExperienceStructured({ rawText: TEXT });
  assert.equal(result.engine, 'rules');
  assert.equal(result.level, null);
  assert.ok((result.banner ?? '').includes('规则模式'));
});

test('有模型：AI 归纳优先，且用规则补上模型漏掉的指标', async () => {
  const model = {
    type: 'internship',
    org: '某某科技有限公司',
    role: '后端开发实习生',
    startDate: '2026-06',
    endDate: '2026-09',
    summary: '优化订单系统性能',
    star: {
      situation: '大促期间订单系统超时',
      task: '把 P99 延迟降到 200ms 以内',
      action: '重写核心查询；引入 Redis 缓存；按用户分库分表',
      result: 'P99 从 800ms 降到 180ms',
    },
    skills: ['Redis'],
    metrics: [],
    evidence: { action: '重写查询、加 Redis 缓存' },
    confidence: 0.82,
  };
  const result = await extractExperienceStructured({ rawText: TEXT, service: fakeService(model) });
  assert.equal(result.engine, 'llm');
  assert.equal(result.level, 'L1');
  assert.ok(result.extraction.star.action.includes('分库分表'));
  assert.ok(result.extraction.metrics.length > 0, '规则应补上模型漏掉的指标');
  assert.ok(result.extraction.metrics.some((item) => item.value === 180));
});

test('模型降级/异常：回退规则并给出警告', async () => {
  const degraded = await extractExperienceStructured({ rawText: TEXT, service: fakeService(null, 'degraded') });
  assert.equal(degraded.engine, 'rules');
  assert.ok(degraded.warnings.length > 0);

  const throwing = {
    hasCredential: true,
    run: async () => { throw new Error('socket hang up'); },
  } as unknown as LLMService;
  const failed = await extractExperienceStructured({ rawText: TEXT, service: throwing });
  assert.equal(failed.engine, 'rules');
  assert.ok(failed.warnings.some((warning) => warning.includes('回退规则')));
});

test('mergeExperienceExtraction：模型 action 为空时用规则原文兜底', () => {
  const rules = extractExperienceFromText(TEXT);
  const model = { ...rules, star: { situation: '', task: '', action: '', result: '' }, org: '', confidence: 0.4 };
  const merged = mergeExperienceExtraction(model, rules);
  assert.equal(merged.star.action, rules.star.action, '不得留空');
  assert.equal(merged.org, rules.org);
});

test('prompt 与消息：注入隔离 + 明确「不虚构」', () => {
  const prompt = loadExperiencePrompt();
  assert.ok(prompt.includes('不许编') || prompt.includes('不虚构'));
  const messages = buildExperienceMessages(TEXT);
  const user = messages[1]!.content;
  assert.equal(typeof user, 'string');
  assert.ok((user as string).startsWith('<experience>'));
  assert.ok((user as string).endsWith('</experience>'));
});

test('normalizeSkills：拆分模型合并的技能（SQL 缓存 → SQL / 缓存）', () => {
  assert.deepEqual(normalizeSkills(['SQL 缓存']), ['SQL', '缓存']);
  assert.deepEqual(normalizeSkills(['Redis、MySQL']), ['Redis', 'MySQL']);
  assert.deepEqual(normalizeSkills(['Spring Boot', 'Node.js']), ['Spring Boot', 'Node.js'], '拉丁词内空格不拆');
  assert.deepEqual(normalizeSkills(['java', 'Java']), ['java'], '大小写去重');
});

test('真实样例回归：模型输出「SQL 缓存」时合并后应为两个技能', async () => {
  const model = {
    type: 'internship',
    org: 'XX 公司',
    role: '后端',
    startDate: '2026-06',
    endDate: '2026-09',
    summary: '负责后端工作，针对系统超时问题改进系统',
    star: {
      situation: '系统老超时',
      task: '改进系统',
      action: '改了几个 SQL 还加了缓存',
      result: 'P99 从 800ms 降到 180ms',
    },
    skills: ['SQL 缓存'],
    metrics: [],
    evidence: {},
    confidence: 0.85,
  };
  const TEXT2 =
    '去年在 XX 公司实习了三个月，主要是做后端，系统老超时。后来我改了几个 SQL 还加了缓存，P99 从 800ms 降到 180ms。';
  const result = await extractExperienceStructured({ rawText: TEXT2, service: fakeService(model) });
  assert.equal(result.engine, 'llm');
  assert.deepEqual(result.extraction.skills.sort(), ['SQL', '缓存'].sort(), '技能必须拆开');
  assert.ok(result.extraction.star.result.includes('180ms'));
});

test('AI 简历切分：模型返回多段 → 原样采用并标注 engine=llm', async () => {
  const { segmentResumeWithLLM } = await import('../src/lib/llm/experience.ts');
  const fake = {
    hasCredential: true,
    run: async () => ({
      status: 'ok',
      data: {
        experiences: [
          {
            type: 'research',
            org: '某某大学',
            role: '科研助理',
            startDate: '2024-06',
            endDate: '2026-06',
            summary: '抑郁症自杀行为的性别因素机制研究',
            star: { situation: '研究机制', task: '分析影像', action: '建立配准管线', result: '完成重建' },
            skills: ['FSL', 'SPM12'],
            metrics: [],
            evidence: {},
            confidence: 0.8,
          },
          {
            type: 'project',
            org: '',
            role: null,
            startDate: '2026-04',
            endDate: '2026-04',
            summary: '手势捕捉小游戏',
            star: { situation: '', task: '', action: '用 Blender 建模', result: '' },
            skills: ['Blender', 'Unity'],
            metrics: [],
            evidence: {},
            confidence: 0.7,
          },
        ],
      },
      level: 'L1',
      path: 'prompt_json',
      degraded: false,
    }),
  } as unknown as import('../src/lib/llm/index.ts').LLMService;

  const result = await segmentResumeWithLLM({ rawText: '一份简历文本……', service: fake });
  assert.equal(result.engine, 'llm');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]!.extraction.type, 'research');
  assert.ok(result.candidates[1]!.rawText.includes('Blender'));
});
