import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryJobRepository } from '../src/lib/db/memory.ts';
import { extractJd } from '../src/lib/llm/extract.ts';
import { createLLM } from '../src/lib/llm/index.ts';
import { toJobDraft, toJobSkillRows } from '../src/lib/jobs/mapping.ts';
import { saveJob } from '../src/lib/jobs/service.ts';
import { validateExtraction } from '../src/lib/pipeline/validate.ts';
import { generateEncryptionKey, validateEnv } from '../src/lib/env.ts';

const USER = '00000000-0000-4000-8000-000000000001';

const JD = `某科技有限公司 招聘 后端开发工程师（2027届校招）
工作地点：上海 / 杭州
薪资：15k-25k，14薪
学历要求：本科及以上
技能要求：必须精通 Java，熟悉 MySQL；具备 Kubernetes 经验优先
岗位职责：参与后端服务设计与开发，保障系统稳定性与性能
截止时间：2026年11月20日`;

const NOW = new Date('2026-10-23T10:00:00+08:00');

test('闭环：规则抽取 → 校验 → 入库 → 列表（无模型、无数据库）', async () => {
  const repo = createMemoryJobRepository();

  const extracted = await extractJd({ rawText: JD, now: NOW });
  assert.equal(extracted.level, null, '无 service → 规则模式');
  assert.equal(extracted.validation.ok, true, `不应有阻塞：${JSON.stringify(extracted.validation.blockers)}`);

  const saved = await saveJob(repo, {
    userId: USER,
    extraction: extracted.extraction,
    validation: extracted.validation,
  });
  assert.equal(saved.status, 'created');

  // 技能属性真的落到了 job_skills
  const skills = await repo.listSkills(saved.job!.id);
  assert.ok(skills.length >= 3, `技能行数 ${skills.length}`);
  assert.ok(skills.some((row) => row.skill === 'Java' && row.proficiency === 'expert' && row.requirement === 'must'));
  assert.ok(skills.some((row) => row.skill === 'Kubernetes' && row.requirement === 'nice_to_have'));

  // 再提交同一岗位 → duplicate
  const again = await saveJob(repo, { userId: USER, extraction: extracted.extraction, validation: extracted.validation });
  assert.equal(again.status, 'duplicate');
  assert.equal(await repo.count(USER), 1);
});

test('闭环：同一 JD 的写法差异（岗位名带括号/城市顺序）→ 仍判为重复', async () => {
  const repo = createMemoryJobRepository();
  const first = await extractJd({ rawText: JD, now: NOW });
  await saveJob(repo, { userId: USER, extraction: first.extraction, validation: first.validation });

  const variant = await extractJd({
    rawText: JD.replace('后端开发工程师', '后端开发工程师（急招）').replace('上海 / 杭州', '杭州 / 上海'),
    now: NOW,
  });
  const draftA = toJobDraft(first.extraction, validateExtraction(first.extraction));
  const draftB = toJobDraft(variant.extraction, validateExtraction(variant.extraction));
  assert.equal(draftA.fingerprint, draftB.fingerprint, '归一化后指纹应相同');

  const saved = await saveJob(repo, { userId: USER, extraction: variant.extraction, validation: variant.validation });
  assert.equal(saved.status, 'duplicate');
});

test('闭环：L0 模型结果 + K=3 一致率 → 低一致字段进待确认 → 仍可入库', async () => {
  const KEY = generateEncryptionKey();
  const env = validateEnv({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:54322/postgres',
    ENCRYPTION_KEY: KEY,
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY: 'sk-test',
  }).env!;

  const payload = (company: string) => ({
    fields: {
      company,
      title: '后端开发工程师',
      cities: ['上海'],
      source: 'manual',
      raw_text: 'x',
      skills: [{ name: 'Java', source: 'explicit', requirement: 'must', proficiency: 'expert', confidence: 0.9, basisPhrase: '精通 Java' }],
      deadline: { kind: 'provided', at: '2026-11-20T23:59:59+08:00', text: '11月20日前' },
    },
    evidence: { company, deadline: '11月20日前', salary_min: '15k-25k' },
    confidence: { company: 0.9, title: 0.9, cities: 0.9, deadline: 0.9, skills: 0.9 },
    needsReview: [],
  });

  const companies = ['某科技有限公司', '某科技有限公司', '另一家公司'];
  let call = 0;
  const service = createLLM(env, {
    skipProbe: true,
    fetchImpl: async () => {
      const company = companies[Math.min(call, companies.length - 1)]!;
      call += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(payload(company)) } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    },
  });

  const extracted = await extractJd({ rawText: JD, now: NOW }, { service, sampleK: 3 });
  assert.equal(extracted.level, 'L0');
  assert.equal(extracted.consistency?.score !== undefined, true);
  assert.equal(extracted.extraction.fields.company, '某科技有限公司', '众数获胜');
  assert.ok(extracted.validation.needsReview.includes('company'), '2/3 一致 → 0.667 < 0.7 → 待确认');

  const repo = createMemoryJobRepository();
  const saved = await saveJob(repo, { userId: USER, extraction: extracted.extraction, validation: extracted.validation });
  assert.equal(saved.status, 'created', '待确认不阻塞入库（由用户确认后清除）');
  assert.ok(saved.job!.review_flags.includes('company'));

  // 技能行数应等于抽取出的技能数
  const rows = toJobSkillRows(extracted.extraction);
  assert.equal((await repo.listSkills(saved.job!.id)).length, rows.length);
});
