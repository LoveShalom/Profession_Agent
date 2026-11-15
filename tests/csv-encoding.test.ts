import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeCsvBuffer } from '../src/lib/workspace/csv.ts';

/** "岗位ID,公司" 的 GBK 字节（Excel 中文版另存 CSV 的典型编码） */
const GBK_BYTES = Buffer.from([
  0xb8, 0xda, 0xce, 0xbb, 0x49, 0x44, // 岗位ID
  0x2c, // ,
  0xb9, 0xab, 0xcb, 0xbe, // 公司
  0x0d, 0x0a,
  0x61, 0x2c, 0x62, 0x0d, 0x0a, // a,b
]);

test('解码：UTF-8 with BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('岗位ID,公司\n', 'utf8')]);
  const decoded = decodeCsvBuffer(buf);
  assert.equal(decoded.encoding, 'utf-8-bom');
  assert.ok(decoded.text.startsWith('岗位ID'));
});

test('解码：纯 UTF-8', () => {
  const decoded = decodeCsvBuffer(Buffer.from('岗位ID,公司\n', 'utf8'));
  assert.equal(decoded.encoding, 'utf-8');
  assert.ok(decoded.text.includes('岗位ID'));
});

test('解码：UTF-16LE（Excel "Unicode 文本"）', () => {
  const text = '岗位ID,公司\n';
  const body = Buffer.from(text, 'utf16le');
  const decoded = decodeCsvBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
  assert.equal(decoded.encoding, 'utf-16le');
  assert.ok(decoded.text.includes('岗位ID'));
});

test('解码回归：中文版 Excel 另存的 GBK 台账（曾导致同步被拒）', () => {
  const decoded = decodeCsvBuffer(GBK_BYTES);
  assert.equal(decoded.encoding, 'gb18030');
  assert.ok(decoded.text.includes('岗位ID'), `实际解出：${decoded.text}`);
  assert.ok(decoded.text.includes('公司'));
  assert.ok(decoded.text.includes('a,b'));
});
