import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveAttachment, removeAttachment } from '../src/lib/ocr/attachments.ts';
import { toJobDraft } from '../src/lib/jobs/mapping.ts';
import { validateExtraction } from '../src/lib/pipeline/validate.ts';
import { workspacePaths } from '../src/lib/workspace/paths.ts';
import {
  clearWorkspaceConfig,
  ensureWorkspaceDir,
  readWorkspaceConfig,
  resolveWorkspaceDir,
  writeWorkspaceConfig,
} from '../src/lib/workspace/settings.ts';
import { ABSENT_DEADLINE, JdExtractionSchema } from '../src/lib/schemas/jd.ts';

/** 测试用宽松 env（ProcessEnv 类型要求部分必填键，这里只关心 WORKSPACE_DIR） */
const asEnv = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 每个用例独立的临时配置/工作区，避免污染项目 data/ */
function setupTemp() {
  const root = mkdtempSync(path.join(tmpdir(), 'psa-ws-settings-'));
  process.env['WORKSPACE_CONFIG_PATH'] = path.join(root, 'workspace-config.json');
  process.env['WORKSPACE_DIR'] = path.join(root, 'from-env');
  return root;
}

// ---------------------------------------------------------------- 目录解析优先级
test('resolveWorkspaceDir：默认 < .env < 运行时配置', () => {
  const root = setupTemp();
  assert.equal(resolveWorkspaceDir(asEnv({})), path.resolve('./data/workspace'), '无配置时用默认');
  assert.equal(resolveWorkspaceDir(asEnv({ WORKSPACE_DIR: path.join(root, 'from-env') })), path.join(root, 'from-env'));

  writeWorkspaceConfig(path.join(root, 'from-config'));
  assert.equal(resolveWorkspaceDir(asEnv({ WORKSPACE_DIR: path.join(root, 'from-env') })), path.join(root, 'from-config'), '配置覆盖 .env');

  clearWorkspaceConfig();
  assert.equal(resolveWorkspaceDir(asEnv({ WORKSPACE_DIR: path.join(root, 'from-env') })), path.join(root, 'from-env'), '清除后回退 .env');
});

test('writeWorkspaceConfig / readWorkspaceConfig：落地 JSON 且可回读', () => {
  const root = setupTemp();
  const config = writeWorkspaceConfig(path.join(root, '台账'));
  assert.equal(config.dir, path.resolve(root, '台账'));
  assert.ok(config.updatedAt.length > 0);
  const read = readWorkspaceConfig();
  assert.equal(read?.dir, config.dir);
  assert.ok(existsSync(process.env['WORKSPACE_CONFIG_PATH']!));
  // 原子写不残留 .tmp
  assert.equal(existsSync(`${process.env['WORKSPACE_CONFIG_PATH']}.tmp`), false);
});

test('ensureWorkspaceDir：不存在则创建；不可用时返回错误而非抛异常', () => {
  const root = setupTemp();
  const target = path.join(root, 'nested', 'deep');
  assert.equal(ensureWorkspaceDir(target).ok, true);
  assert.ok(existsSync(target));
  // Windows 上非法字符路径
  const invalid = ensureWorkspaceDir(path.join(root, 'bad\u0000name'));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.error);
});

test('readWorkspaceConfig：文件损坏时返回 null（不抛错）', () => {
  const root = setupTemp();
  writeFileSync(process.env['WORKSPACE_CONFIG_PATH']!, '{ not json', 'utf8');
  assert.equal(readWorkspaceConfig(), null);
  assert.equal(resolveWorkspaceDir(asEnv({ WORKSPACE_DIR: path.join(root, 'fallback') })), path.join(root, 'fallback'));
});

// ---------------------------------------------------------------- 截图附件
test('saveAttachment：写入工作区 attachments，返回相对路径', () => {
  const root = setupTemp();
  const result = saveAttachment(PNG, { dir: root });
  assert.match(result.relativePath, /^原始JD\/attachments\/[0-9a-f]{16}\.png$/);
  assert.ok(existsSync(result.absolutePath));
  assert.equal(result.deduped, false);
  assert.equal(result.bytes, Buffer.from(PNG.split(',')[1]!, 'base64').length);

  const again = saveAttachment(PNG, { dir: root });
  assert.equal(again.deduped, true, '同内容不重复落盘');
  assert.equal(again.absolutePath, result.absolutePath);
});

test('saveAttachment：拒绝非图片 data URL', () => {
  const root = setupTemp();
  assert.throws(() => saveAttachment('data:text/plain;base64,aGk=', { dir: root }), /data URL/);
  assert.throws(() => saveAttachment('https://example.com/a.png', { dir: root }), /data URL/);
});

test('removeAttachment：只删附件目录内的文件（防目录穿越）', () => {
  const root = setupTemp();
  const saved = saveAttachment(PNG, { dir: root });
  assert.equal(removeAttachment(saved.relativePath, { dir: root }), true);
  assert.equal(existsSync(saved.absolutePath), false);

  const outside = path.join(workspacePaths(root).rawDir, 'x.md');
  writeFileSync(outside, 'x', 'utf8');
  assert.equal(removeAttachment('原始JD/x.md', { dir: root }), false, '目录外路径必须拒绝');
  assert.ok(existsSync(outside));
});

// ---------------------------------------------------------------- 来源截图入库
test('toJobDraft：传入 sourceImage 时写入 jd_structured.source_image', () => {
  const data = JdExtractionSchema.parse({
    fields: {
      company: '某公司',
      title: '后端开发工程师',
      cities: ['上海'],
      source: 'manual',
      raw_text: '某公司招聘后端开发工程师',
      deadline: ABSENT_DEADLINE,
    },
  });
  const withImage = toJobDraft(data, validateExtraction(data), { sourceImage: '原始JD/attachments/abc.png' });
  assert.equal((withImage.jd_structured as { sourceImage?: string }).sourceImage, '原始JD/attachments/abc.png');

  const without = toJobDraft(data, validateExtraction(data));
  assert.equal('sourceImage' in without.jd_structured, false, '没有截图时不应写入该字段');
});

test('工作区文件：README 会说明附件目录含个人信息', () => {
  const root = setupTemp();
  // 触发导出前的最小路径构造，确认目录名稳定
  const paths = workspacePaths(root);
  assert.equal(paths.attachmentsDir, path.join(root, '原始JD', 'attachments'));
  // README 文本由导出写入，这里只校验常量包含提示
  const readme = readFileSync('src/lib/workspace/paths.ts', 'utf8');
  assert.ok(readme.includes('可能包含个人信息'));
});
