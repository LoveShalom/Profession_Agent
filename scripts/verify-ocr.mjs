#!/usr/bin/env node
/**
 * F-04 截图 OCR 验收器（AC-6 识别质量实测）
 *
 * 把一张真实 JD 截图跑完整链路并逐项对照：
 *   截图 → 视觉模型识别 → 文本 → F-02 抽取管线 → 关键字段核对
 *
 * 用法：
 *   node scripts/verify-ocr.mjs --image data/tmp/psa-jd-screenshot.png
 *   node scripts/verify-ocr.mjs --image shot.png --report evals/reports/F-04-ocr.txt
 *
 * 说明：会真实调用模型（1 次视觉 + 1 次文本，约 ¥0.01），不加 --real 也照跑——
 * 这个工具本身就是"真实质量实测"，不接受 mock。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateEnv } from '../src/lib/env.ts';
import { extractJd } from '../src/lib/llm/extract.ts';
import { createModelRouter } from '../src/lib/llm/profiles.ts';
import { recognizeImages } from '../src/lib/ocr/recognize.ts';

const argv = process.argv.slice(2);
const imageIndex = argv.indexOf('--image');
const imagePath = imageIndex >= 0 ? argv[imageIndex + 1] : 'data/tmp/psa-jd-screenshot.png';
const reportIndex = argv.indexOf('--report');
const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;

const lines = [];
const log = (...args) => {
  const line = args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ');
  lines.push(line);
  console.log(line);
};

function readDotEnv() {
  const parsed = {};
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index <= 0) continue;
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) parsed[trimmed.slice(0, index).trim()] = value;
    }
  } catch {
    /* 无 .env 时用 process.env */
  }
  return parsed;
}

const loaded = validateEnv({ ...readDotEnv(), ...process.env });
if (!loaded.ok) {
  console.error('❌ .env 校验失败，先运行 npm run doctor');
  process.exit(2);
}
const env = loaded.env;
const router = createModelRouter(env);

log('=== ① 模型路由 ===');
log(`文本：${router.info.text.provider} / ${router.info.text.model}`);
log(`视觉：${router.info.vision.provider} / ${router.info.vision.model}（supportsVision=${router.info.vision.supportsVision}）`);
if (!router.vision) {
  console.error(`❌ 视觉模型不可用：${router.info.vision.reason ?? '未配置'}`);
  process.exit(2);
}

let imageBytes;
try {
  imageBytes = readFileSync(imagePath);
} catch {
  console.error(`❌ 找不到图片：${imagePath}`);
  console.error('   可以先用 npm run dev 打开 /jobs/new 截图，或指定 --image <路径>');
  process.exit(2);
}
const dataUrl = `data:image/jpeg;base64,${imageBytes.toString('base64')}`;
const mimeDataUrl = imagePath.toLowerCase().endsWith('.png')
  ? `data:image/png;base64,${imageBytes.toString('base64')}`
  : dataUrl;

log(`\n=== ② 截图识别（${Math.round(imageBytes.length / 1024)} KB）===`);
const started = Date.now();
const ocr = await recognizeImages([mimeDataUrl], {
  service: router.vision,
  provider: router.info.vision.provider,
  model: router.info.vision.model,
});
log(`耗时 ${((Date.now() - started) / 1000).toFixed(2)}s`);
if (!ocr.ok) {
  log(`❌ 识别失败：${ocr.code} ${ocr.message}`);
  log(`   hint: ${ocr.hint ?? ''}`);
  if (reportPath) {
    mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    writeFileSync(path.resolve(reportPath), `${lines.join(os.EOL)}${os.EOL}`, 'utf8');
  }
  process.exit(1);
}
log(`✅ 识别成功：${ocr.imageCount} 张 / ${ocr.text.length} 字`);
log('--- 识别文本 ---');
log(ocr.text);
log('--- 结束 ---');

log('\n=== ③ 文本 → JD 抽取（与手动粘贴同一条管线）===');
const extracted = await extractJd({ rawText: ocr.text }, { service: router.text, sampleK: env.sampleK });
const fields = extracted.extraction.fields;
log(`level=${extracted.level} path=${extracted.path} ok=${extracted.ok}`);
log(`公司=${fields.company} | 岗位=${fields.title} | 城市=${fields.cities.join('/')}`);
log(`薪资=${fields.salary_min ?? '—'}-${fields.salary_max ?? '—'} · ${fields.salary_months ?? '—'}薪 | 学历=${fields.education} | 届别=${fields.graduation_year ?? '—'}`);
log(`截止=${fields.deadline.kind} ${fields.deadline.at ?? ''} (${fields.deadline_text ?? ''})`);
log(`技能(${fields.skills.length})：${fields.skills.map((item) => `${item.name}[${item.source}/${item.requirement}]`).join('、')}`);
log(`待确认=${extracted.validation.needsReview.length} 阻塞=${extracted.validation.blockers.length}`);

log('\n=== ④ 关键项对照 ===');
const checks = [
  ['公司非空且非占位', fields.company.length > 0 && !fields.company.includes('待填写')],
  ['岗位非空且非占位', fields.title.length > 0 && !fields.title.includes('待填写')],
  ['城市 ≥1', fields.cities.length >= 1],
  ['抽取层级 L0 或 L1（AI 路径）', extracted.level === 'L0' || extracted.level === 'L1'],
  ['阻塞 = 0', extracted.validation.blockers.length === 0],
  ['截止三态合法', ['provided', 'text_only', 'absent'].includes(fields.deadline.kind)],
];
let pass = 0;
for (const [label, ok] of checks) {
  log(`${ok ? '✅' : '❌'} ${label}`);
  if (ok) pass += 1;
}

log(`\n结果：${pass}/${checks.length} 通过${pass === checks.length ? '（验收通过）' : '（需人工检查识别文本与截图是否一致）'}`);

if (reportPath) {
  const absolute = path.resolve(reportPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${lines.join(os.EOL)}${os.EOL}`, 'utf8');
  console.log(`\n📄 报告已写入：${absolute}（UTF-8）`);
}

process.exit(pass === checks.length ? 0 : 1);
