import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_COLUMNS,
  JOB_STATUSES,
  MIN_NOTE_LENGTH,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  decideTransition,
  describeTransition,
  isJobStatus,
  isTerminal,
  statusIndex,
  statusLabel,
  validateNote,
  type JobStatus,
} from '../src/lib/status.ts';

// ---------------------------------------------------------------- 枚举与文案
test('状态枚举：13 个、顺序固定、终态 4 个', () => {
  assert.equal(JOB_STATUSES.length, 13);
  assert.deepEqual(JOB_STATUSES.slice(0, 3), ['saved', 'to_apply', 'applied']);
  assert.deepEqual(JOB_STATUSES.slice(-4), ['accepted', 'rejected_by_company', 'withdrawn', 'expired']);
  assert.deepEqual(TERMINAL_STATUSES, ['accepted', 'rejected_by_company', 'withdrawn', 'expired']);
  assert.deepEqual(BOARD_COLUMNS.length, 9, '看板默认 9 个非终态列');
});

test('每个状态都有中文文案，且没有重复/空值', () => {
  const labels = JOB_STATUSES.map((status) => STATUS_LABELS[status]);
  assert.equal(labels.every((label) => typeof label === 'string' && label.length > 0), true);
  assert.equal(new Set(labels).size, labels.length, '文案不应重复');
  assert.equal(statusLabel('applied'), '已投递');
});

test('isJobStatus：只认枚举内值', () => {
  assert.equal(isJobStatus('saved'), true);
  assert.equal(isJobStatus('offer'), false, '历史缩写 `offer` 不是合法枚举');
  assert.equal(isJobStatus(''), false);
  assert.equal(isJobStatus(null), false);
  assert.equal(isJobStatus(123), false);
});

test('statusIndex：行序即先后（saved 最早）', () => {
  assert.equal(statusIndex('saved'), 0);
  assert.ok(statusIndex('expired') > statusIndex('offered'));
  assert.equal(isTerminal('expired'), true);
  assert.equal(isTerminal('offered'), false);
});

// ---------------------------------------------------------------- 规则（穷举）
/** 独立实现的期望规则：用来交叉验证 decideTransition，而不是复述同一段代码 */
function expected(from: JobStatus, to: JobStatus) {
  if (from === to) return { allowed: true, unchanged: true, requiresNote: false, kind: 'same' };
  const fromTerminal = TERMINAL_STATUSES.includes(from);
  const toTerminal = TERMINAL_STATUSES.includes(to);
  if (fromTerminal && toTerminal) return { allowed: false, kind: 'terminal-to-terminal' };
  if (fromTerminal) return { allowed: true, requiresNote: true, kind: 'reactivation' };
  if (statusIndex(to) < statusIndex(from)) return { allowed: true, requiresNote: true, kind: 'rollback' };
  return { allowed: true, requiresNote: toTerminal, kind: 'forward' };
}

test('转移矩阵：13×13 = 169 组合全部穷举，与独立实现的期望一致', () => {
  const failures: string[] = [];
  for (const from of JOB_STATUSES) {
    for (const to of JOB_STATUSES) {
      const decision = decideTransition(from, to);
      const want = expected(from, to);
      if (decision.allowed !== want.allowed) failures.push(`${from}→${to} allowed 应=${want.allowed}`);
      if (decision.kind !== want.kind) failures.push(`${from}→${to} kind 应=${want.kind} 实=${decision.kind}`);
      if (want.requiresNote !== undefined && decision.requiresNote !== want.requiresNote) {
        failures.push(`${from}→${to} requiresNote 应=${want.requiresNote}`);
      }
      if (decision.unchanged !== (from === to)) failures.push(`${from}→${to} unchanged 判定错误`);
      if (!decision.allowed && (decision.reason ?? '').length === 0) failures.push(`${from}→${to} 拒绝时缺少原因文案`);
    }
  }
  assert.deepEqual(failures, [], failures.slice(0, 5).join('；'));
});

test('只拒绝「终态 → 终态」这一类流转（其余都允许）', () => {
  const rejected = JOB_STATUSES.flatMap((from) => JOB_STATUSES.filter((to) => !decideTransition(from, to).allowed).map((to) => `${from}→${to}`));
  const expectedRejected = TERMINAL_STATUSES.flatMap((from) =>
    TERMINAL_STATUSES.filter((to) => to !== from).map((to) => `${from}→${to}`),
  );
  assert.deepEqual(rejected.sort(), expectedRejected.sort(), '拒绝集合应恰好是终态互转（12 种）');
});

test('具体场景：跨步前进 / 回退 / 重新激活 / 进入终态', () => {
  assert.deepEqual(decideTransition('applied', 'interviewing'), {
    allowed: true,
    unchanged: false,
    requiresNote: false,
    kind: 'forward',
  });
  assert.deepEqual(decideTransition('interviewing', 'applied'), {
    allowed: true,
    unchanged: false,
    requiresNote: true,
    kind: 'rollback',
  });
  assert.deepEqual(decideTransition('withdrawn', 'applied'), {
    allowed: true,
    unchanged: false,
    requiresNote: true,
    kind: 'reactivation',
  });
  assert.equal(decideTransition('applied', 'rejected_by_company').requiresNote, true, '进入终态必须备注');
  assert.equal(decideTransition('withdrawn', 'expired').allowed, false);
});

test('validateNote：回退/重新激活/终态需要备注，前进不需要', () => {
  assert.equal(validateNote('拖错列了', decideTransition('interviewing', 'applied')), null);
  assert.match(validateNote('', decideTransition('interviewing', 'applied')) ?? '', /回退/);
  assert.match(validateNote('我', decideTransition('withdrawn', 'applied')) ?? '', new RegExp(String(MIN_NOTE_LENGTH)));
  assert.equal(validateNote(null, decideTransition('applied', 'assessment')), null, '前进不需要备注');
  assert.match(validateNote('', decideTransition('applied', 'rejected_by_company')) ?? '', /结束状态/);
});

test('describeTransition：给时间线用的可读文案', () => {
  assert.equal(describeTransition('to_apply', 'applied'), '待投递 → 已投递');
  assert.equal(describeTransition('withdrawn', 'applied'), '本人放弃 → 已投递');
});
