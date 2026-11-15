/**
 * 评测集生成器（F-09 / I4 T1）
 *
 * 输出 `evals/jd/dataset.jsonl`：40 条合成 JD + 对应 gold 标注 + `dataset.lock.json`（内容哈希）。
 * 为什么用生成器而不是手写：40 条要有结构化的边界覆盖（截止三态 / 薪资面议 / 多城市 / 技能密度），
 * 手写容易漏类型；生成器保证分布可控，生成结果作为源文件提交，lock 防止随手改。
 *
 * 用法：
 *   node scripts/gen-eval-dataset.mjs            # 生成
 *   node scripts/gen-eval-dataset.mjs --check    # 只校验 lock 是否与现有文件一致
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DATASET = 'evals/jd/dataset.jsonl';
const LOCK = 'evals/jd/dataset.lock.json';

const COMPANIES = [
  '星辰科技有限公司', '云图数据科技有限公司', '灵犀智能科技有限公司', '海风网络科技有限公司', '极光安全科技有限公司',
  '青禾医疗科技有限公司', '远山金融科技有限公司', '北辰物流有限公司', '拾光教育科技有限公司', '钜子芯片有限公司',
];

const ROLES = [
  { title: '后端开发工程师', skills: ['Java', 'Spring Boot', 'MySQL', 'Redis'] },
  { title: '前端开发工程师', skills: ['TypeScript', 'React', 'Webpack'] },
  { title: '算法工程师', skills: ['Python', 'PyTorch', '机器学习'] },
  { title: '数据仓库工程师', skills: ['SQL', 'Spark', 'Hive'] },
  { title: '测试开发工程师', skills: ['Python', 'Selenium', 'Jenkins'] },
  { title: '运维工程师', skills: ['Linux', 'Kubernetes', 'Docker'] },
  { title: '产品经理', skills: ['需求分析', 'Axure', '数据分析'] },
  { title: '嵌入式工程师', skills: ['C', 'C++', 'FreeRTOS'] },
];

const CITIES = [
  ['上海'],
  ['北京'],
  ['深圳'],
  ['杭州'],
  ['广州', '深圳'],
  ['成都'],
  ['武汉', '上海'],
];

/** 截止三态：provided / text_only / absent */
const DEADLINES = [
  { kind: 'provided', at: '2026-12-31T23:59:59+08:00', text: null, textOf: '截止 2026-12-31' },
  { kind: 'provided', at: '2026-12-15T23:59:59+08:00', text: null, textOf: '2026年12月15日前投递' },
  { kind: 'text_only', at: null, text: '招满为止', textOf: '招满为止' },
  { kind: 'text_only', at: null, text: '尽快投递', textOf: '尽快投递' },
  { kind: 'absent', at: null, text: null, textOf: '' },
];

const SALARIES = [
  // 注意：产品薪资字段单位是「元/月」，不是 K
  { min: 20000, max: 30000, text: '薪资范围 20K~30K' },
  { min: 15000, max: 25000, text: '薪资 15k-25k' },
  { min: null, max: null, text: '薪资面议' },
];

mkdirSync('evals/jd', { recursive: true });

const items = [];
for (let index = 0; index < 40; index += 1) {
  const company = COMPANIES[index % COMPANIES.length];
  const role = ROLES[index % ROLES.length];
  const cities = CITIES[index % CITIES.length];
  const deadline = DEADLINES[index % DEADLINES.length];
  const salary = SALARIES[index % SALARIES.length];

  const cityText = cities.join(' / ');
  const rawText = [
    `${company} 招聘 ${role.title}`,
    `工作地点：${cityText}`,
    `岗位职责：负责${role.title.replace('工程师', '')}相关系统的设计与开发；参与需求评审与技术方案设计。`,
    `任职要求：熟悉 ${role.skills.join('、')}；本科及以上学历；${index % 3 === 0 ? '3 年以上相关经验。' : '有良好的沟通能力。'}`,
    `${salary.text}。`,
    deadline.textOf ? `投递方式：简历发送至 hr@example.com，${deadline.textOf}。` : '',
  ]
    .filter(Boolean)
    .join('\n');

  items.push({
    id: `jd-${String(index + 1).padStart(3, '0')}`,
    raw_text: rawText,
    gold: {
      company,
      title: role.title,
      cities,
      deadline_kind: deadline.kind,
      deadline_at: deadline.at,
      salary_min: salary.min,
      salary_max: salary.max,
      skills: role.skills,
    },
    tags: [
      `deadline:${deadline.kind}`,
      salary.min === null ? 'salary:negotiable' : 'salary:range',
      cities.length > 1 ? 'city:multi' : 'city:single',
    ],
  });
}

const content = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
const hash = createHash('sha256').update(content).digest('hex');

if (process.argv.includes('--check')) {
  if (!existsSync(LOCK)) {
    console.error('✖ 缺少 dataset.lock.json');
    process.exit(1);
  }
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  if (lock.sha256 !== hash) {
    console.error('✖ 评测集内容与 lock 不一致：请 review 改动后运行 `npm run eval:dataset` 重新生成并提交 lock');
    console.error(`   lock=${lock.sha256.slice(0, 16)}… 实际=${hash.slice(0, 16)}…`);
    process.exit(1);
  }
  console.log(`✅ 评测集与 lock 一致（${items.length} 条，sha256=${hash.slice(0, 16)}…）`);
  process.exit(0);
}

writeFileSync(DATASET, content, 'utf8');
writeFileSync(
  LOCK,
  JSON.stringify(
    {
      sha256: hash,
      items: items.length,
      version: 1,
      generatedAt: new Date().toISOString(),
      note: '评测集是质量契约：改条目必须重新生成 lock，并在 decisions_log 记录原因',
    },
    null,
    2,
  ) + '\n',
  'utf8',
);
console.log(`✅ 已生成 ${items.length} 条评测集：${DATASET}`);
console.log(`✅ lock：${LOCK}（sha256=${hash.slice(0, 16)}…）`);
