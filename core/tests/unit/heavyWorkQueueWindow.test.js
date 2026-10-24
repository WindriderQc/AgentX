'use strict';
const { executionWindowOpen } = require('../../src/services/heavyWorkQueueWindow');
const at = minute => `2030-01-01T12:${String(minute).padStart(2, '0')}:00.000Z`;
const job = extra => ({ state: 'dispatching', dispatchId: 'original-dispatch',
  reservation: { start: at(0), end: at(20) }, notBefore: at(0), startBefore: at(5),
  dispatchedAt: at(4), ...extra });

test.each(['dispatching', 'running'])('a timely %s dispatch admits subsequent calls after the start deadline', state => {
  expect(executionWindowOpen(job({ state }), at(4))).toBe(true);
  expect(executionWindowOpen(job({ state }), at(5))).toBe(true);
  expect(executionWindowOpen(job({ state }), at(19))).toBe(true);
  expect(executionWindowOpen(job({ state }), at(20))).toBe(false);
});
test.each([
  { state: 'reserved' }, { state: 'uncertain' }, { state: 'failed' },
  { dispatchedAt: null }, { dispatchedAt: 'invalid' }, { dispatchId: null },
  { dispatchedAt: at(5) }, { dispatchedAt: at(6) }, { dispatchedAt: at(10) },
  { dispatchedAt: '2030-01-01T11:59:00.000Z' },
  { notBefore: at(5) }, { startBefore: 'invalid' }, { notBefore: 'invalid' },
  { reservation: null }, { reservation: { start: at(10), end: at(0) } },
])('refuses invalid, late, uncertain or unstarted identities: %j', extra => {
  expect(executionWindowOpen(job(extra), at(7))).toBe(false);
});
test('retains reservation boundaries when no optional start deadline exists', () => {
  const value = job({ startBefore: null, notBefore: null });
  expect(executionWindowOpen(value, at(7))).toBe(true);
  expect(executionWindowOpen(value, at(3))).toBe(false);
  expect(executionWindowOpen(value, 'invalid')).toBe(false);
});
