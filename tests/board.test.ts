import test from 'node:test';
import assert from 'node:assert/strict';

import { deadlineCountdown, groupJobs, neighborStatus, type BoardJobLike } from '../src/lib/jobs/board.ts';
import { BOARD_COLUMNS, TERMINAL_STATUSES } from '../src/lib/status.ts';

const NOW = new Date('2026-11-11T10:00:00+08:00');

test('倒计时：T-N 分档、今天截止、已过期、无截止、纯文本', () => {
  const make = (deadlineKind: string, deadline: string | null) =>
    deadlineCountdown({ deadlineKind, deadline }, NOW);

  assert.deepEqual(make('provided', '2026-11-14T23:59:59+08:00'), { label: 'T-3 天', tone: 'danger', days: 3 });
  assert.deepEqual(make('provided', '2026-11-16T23:59:59+08:00'), { label: 'T-5 天', tone: 'warn', days: 5 });
  assert.deepEqual(make('provided', '2026-11-20T23:59:59+08:00'), { label: 'T-9 天', tone: 'ok', days: 9 });
  assert.deepEqual(make('provided', '2026-11-11T23:59:59+08:00'), { label: '今天截止', tone: 'danger', days: 0 });
  assert.deepEqual(make('provided', '2026-11-09T23:59:59+08:00'), { label: '已过期 2 天', tone: 'muted', days: 2 });
  assert.deepEqual(make('absent', null), { label: '未提供', tone: 'muted', days: null });
  assert.deepEqual(make('text_only', null), { label: '见原文', tone: 'muted', days: null });
});

test('邻居状态：←/→ 在 9 个非终态列内移动，边界返回 null', () => {
  assert.equal(neighborStatus('saved', 'right'), 'to_apply');
  assert.equal(neighborStatus('applied', 'left'), 'to_apply');
  assert.equal(neighborStatus('interviewing', 'right'), 'offer_pending');
  assert.equal(neighborStatus('saved', 'left'), null, '第一列再往左无目标');
  assert.equal(neighborStatus('offered', 'right'), null, '最后一列再往右无目标');
  for (const terminal of TERMINAL_STATUSES) {
    assert.equal(neighborStatus(terminal, 'left'), null, `${terminal} 不在看板列内`);
    assert.equal(neighborStatus(terminal, 'right'), null);
  }
});

test('分组：非终态进列、终态进折叠区、未知状态单独收集', () => {
  const job = (id: string, status: string, deadline: string | null = null): BoardJobLike => ({
    id,
    company: `公司${id}`,
    title: '岗位',
    cities: ['上海'],
    status,
    priority: '中',
    deadline,
    deadlineKind: deadline ? 'provided' : 'absent',
    createdAt: '2026-11-01T00:00:00.000Z',
  });

  const grouped = groupJobs([
    job('1', 'saved', '2026-11-20T23:59:59+08:00'),
    job('2', 'saved', '2026-11-13T23:59:59+08:00'),
    job('3', 'applied'),
    job('4', 'offered'),
    job('5', 'withdrawn'),
    job('6', 'offer'), // 历史脏值
  ]);

  assert.equal(grouped.columns.size, BOARD_COLUMNS.length);
  assert.deepEqual(grouped.columns.get('saved')!.map((item) => item.id), ['2', '1'], '列内按截止升序，无截止置后');
  assert.deepEqual(grouped.columns.get('applied')!.map((item) => item.id), ['3']);
  assert.deepEqual(grouped.terminal.map((item) => item.id), ['5']);
  assert.deepEqual(grouped.unknown.map((item) => item.id), ['6']);
});
