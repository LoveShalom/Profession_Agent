import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  ResumeImportError,
  cleanResumeText,
  parseResume,
  segmentExperiences,
} from '../src/lib/resume/import.ts';

const RESUME_TEXT = [
  '个人简历',
  '张三 · 后端开发',
  '',
  '某某科技有限公司  后端开发实习生',
  '2024.06-2024.09',
  '参与订单系统开发，背景：大促期间频繁超时。',
  '任务：把 P99 降到 200ms 以内。',
  '行动：重写慢查询、引入 Redis 缓存。',
  '结果：P99 从 800ms 降到 180ms。',
  '',
  '某某大学实验室  科研助理',
  '2023.09-2024.05',
  '负责数据清洗脚本，使用 Python 处理日志。',
  '结果：处理速度提升 40%。',
].join('\n');

// ---------------------------------------------------------------- 文本清洗
test('cleanResumeText：剔除重复页眉与页码，合并多余空行', () => {
  const raw = ['某某大学 第 3 页', '正文 A', '某某大学 第 3 页', '正文 B', '1 / 5', '某某大学 第 3 页', ''].join('\n');
  const result = cleanResumeText(raw);
  assert.ok(result.text.includes('正文 A'));
  assert.ok(result.text.includes('正文 B'));
  assert.equal(result.text.includes('第 3 页'), false, '页眉/页码应被剔除');
  assert.ok(result.removed >= 3);
});

// ---------------------------------------------------------------- 经历切分
test('segmentExperiences：按时间/组织锚点切成多段候选', () => {
  const candidates = segmentExperiences(RESUME_TEXT);
  assert.equal(candidates.length, 2, `应识别 2 段，实际 ${candidates.length}`);
  assert.ok(candidates[0]!.rawText.includes('后端开发实习生'));
  assert.ok(candidates[1]!.rawText.includes('科研助理'));
  assert.equal(candidates[0]!.extraction.type, 'internship');
  assert.equal(candidates[1]!.extraction.type, 'research');
  assert.ok(candidates[0]!.extraction.star.action.includes('Redis'));
  assert.ok(candidates[1]!.extraction.metrics.some((metric) => metric.value === 40));
});

test('segmentExperiences：没有锚点时整份作为一条候选（不硬拆）', () => {
  const candidates = segmentExperiences('我做过一个内部工具，用 Node.js 写了个命令行脚本，帮团队自动整理数据。');
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0]!.rawText.includes('Node.js'));
});

test('segmentExperiences：内容太少 → E_NO_EXPERIENCE（不猜）', () => {
  assert.throws(
    () => segmentExperiences('简历'),
    (error: unknown) => error instanceof ResumeImportError && error.code === 'E_NO_EXPERIENCE',
  );
});

test('segmentExperiences：同组织同起始月的重复块会被去重', () => {
  const duplicated = [
    '某某科技有限公司 后端开发实习生',
    '2024.06-2024.09',
    '行动：重写慢查询，结果提升 30%。',
    '',
    '某某科技有限公司 后端开发实习生',
    '2024.06-2024.09',
    '行动：重写慢查询，结果提升 30%。',
  ].join('\n');
  const candidates = segmentExperiences(duplicated);
  assert.equal(candidates.length, 1);
});

// ---------------------------------------------------------------- 解析入口
test('parseResume：不支持的格式 → E_UNSUPPORTED_FORMAT（提示两条替代路径）', async () => {
  await assert.rejects(
    () => parseResume({ name: 'resume.txt', mime: 'text/plain', data: Buffer.from('hi') }),
    (error: unknown) =>
      error instanceof ResumeImportError &&
      error.code === 'E_UNSUPPORTED_FORMAT' &&
      (error.hint ?? '').includes('截图识别'),
  );
});

test('parseResume：超过 10MB → E_TOO_LARGE', async () => {
  await assert.rejects(
    () => parseResume({ name: 'big.pdf', mime: 'application/pdf', data: Buffer.alloc(10 * 1024 * 1024 + 1) }),
    (error: unknown) => error instanceof ResumeImportError && error.code === 'E_TOO_LARGE',
  );
});

test('parseResume：损坏的 PDF → E_PARSE_FAILED（说明依赖真实可用，不是"缺依赖"）', async () => {
  await assert.rejects(
    () => parseResume({ name: 'cv.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 这不是合法 PDF') }),
    (error: unknown) => error instanceof ResumeImportError && error.code === 'E_PARSE_FAILED',
  );
});

test('真实 DOCX 样本：解析 + 切分（fixture 缺失则跳过）', async () => {
  const fixture = 'tests/fixtures/resume-sample.docx';
  if (!existsSync(fixture)) return;
  const data = readFileSync(fixture);
  const parsed = await parseResume({ name: 'resume-sample.docx', mime: '', data });

  assert.equal(parsed.format, 'docx');
  assert.equal(parsed.hasTextLayer, true);
  assert.equal(parsed.text.includes('页脚占位'), false, '重复页脚应被剔除');

  const candidates = segmentExperiences(parsed.text);
  assert.equal(candidates.length, 2, `应切成 2 段（头部不算经历），实际 ${candidates.length}`);
  assert.ok((candidates[0]!.extraction.org ?? '').includes('某某科技'));
  assert.ok((candidates[0]!.extraction.star.situation ?? '').includes('超时'), '同行「背景：」应被识别');
  assert.ok(candidates[0]!.extraction.metrics.some((metric) => metric.value === 180));
  assert.ok(candidates[0]!.extraction.skills.some((skill) => skill.toLowerCase() === 'redis'));
  assert.equal(candidates[1]!.extraction.type, 'research');
});

test('简历切分（乱序 PDF）：剔除教育与个人信息 + 区分多段经历', () => {
  const text = "香港中文大学（深圳） 硕士计算机科学与技术预计毕业时间：2028.5主修课程：计算机算法设计与分析，人工智能，深度学习，自然语言处理教育背景香港中文大学（深圳） 本科计算机科学与技术2022.09 -- 2026.05\n主修课程：数据结构，机器学习，数据库系统，操作系统，计算机体系结构，软件工程科研经历邓一凡手机号码：17342658727邮箱：17342658727@163.com\n求职意向：算法工程师｜抑郁症自杀行为的性别因素机制的研究\n已完成全部受试者DTI、DKI、NODDI、WMTI及MAP-MRI等模型的重建，建立基于SPM12的配准管线；\n基于FSL工具，采用双因素方差分析，采用无阈值簇增强（TFCE）与非参数置换检验进行体素水平多重比较校正。2024.6 -- 2026.6基于多参数磁共振的缺血性脑卒中干细胞治疗疗效评估影像标志物研究2023.9 -- 2025.10\n开发基于代价函数掩蔽（CFM）的非线性配准优化策略，确保健康脑区驱动的精确MNI空间对齐；\n构建高斯混合模型（GMM）先验约束下的水平集演化框架，实现缺血半暗带与梗死核心的精准概率分割。抑郁症自杀行为的ETC治疗前后差异比较2026.6 -- 至今\n基于FSL工具，对病人的DTI、DKI等模型进行TBSS分析。\n项目经历手势捕捉怪物击杀小游戏2026.4.1 -- 2026.4.30Unity，Blender，TouchDesigner | 课程项目\n项目简介：小组设计了手势捕捉击杀怪物的小游戏。本人承担的角色：游戏的美工设计。主要贡献：独立完成武器剑、锤、枪、盾牌以及怪物场景的设计。";
  const candidates = segmentExperiences(text);
  const all = candidates.map((item) => item.rawText).join("\n");

  // 规则切分对双栏乱序 PDF 只能尽力而为：AI 切分（segmentResumeWithLLM）才是主路径
  assert.ok(candidates.length >= 2, `规则兜底应至少切出 2 段，实际 ${candidates.length}`);
  assert.equal(/主修课程/.test(all), false, '教育背景不得混入经历');
  assert.equal(/手机号码|邮箱/.test(all), false, '个人信息不得混入经历');
  assert.ok(candidates.some((item) => item.rawText.includes('缺血性脑卒中')), '应包含缺血性脑卒中项目');
  assert.ok(candidates.some((item) => item.rawText.includes('ETC')), '应包含 ETC 项目');
  assert.ok(candidates.some((item) => item.rawText.includes('手势捕捉')), '应包含游戏项目');
  const withDate = candidates.filter((item) => item.extraction.startDate !== null).length;
  assert.ok(withDate >= 2, `至少两段应识别出时间，实际 ${withDate}`);
});

test('同一章节两个项目（日期带日）：必须切成两段', () => {
  const text = [
    '项目经历',
    '手势捕捉怪物击杀小游戏2026.4.1 -- 2026.4.30Unity， Blender， TouchDesigner | 课程项目',
    '项目简介：小组设计了手势捕捉击杀怪物的小游戏。',
    '本人承担的角色：游戏的美工设计。',
    '主要贡献：独立完成武器与怪物建模，并完成模型导入 Unity 的优化。华为ADS × CUHK-Shenzhen Capstone项目',
    '2026.1 - 2026.5',
    '项目简介：探索2D视觉基础模型SAM3的语义先验对BEVFormer检测的提升效果。',
    '主要贡献：在KITTI上搭建SAM3闭环提示检测管线，零样本AP50达52.1%。',
  ].join("\n");

  const candidates = segmentExperiences(text);
  assert.equal(candidates.length, 2, `应切成 2 段，实际 ${candidates.length}`);
  assert.ok(candidates[0]!.rawText.includes('手势捕捉'), '第一段是游戏项目');
  assert.ok(candidates[1]!.rawText.includes('Capstone') || candidates[1]!.rawText.includes('SAM3'), '第二段是 ADS 项目');
  assert.equal(candidates[0]!.extraction.startDate, '2026-04', '带日的日期应识别为 2026-04');
});
