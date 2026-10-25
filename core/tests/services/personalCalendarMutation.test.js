'use strict';
const { randomUUID } = require('crypto');
const { request, operate } = require('../../src/services/personalCalendarService');
const Operation = require('../../models/PersonalCalendarOperation');
const { callSecretaryTool } = require('../../surfaces/household/secretary-mcp');
const base = { action: 'update', requestId: 'c54509b5-a7c2-49c5-92b4-d694d42efca1', calendarId: 'fixture',
  eventId: 'synthetic', expectedEtag: '"v1"', scope: 'event', title: 'Changed fixture' };
const receipt = payload => ({ event: { id: payload.eventId, etag: '"v2"', summary: payload.patch.summary }, mutationObserved: true });
beforeEach(() => Operation.deleteMany({}));

test.each([
  { expectedEtag: undefined }, { expectedEtag: '*' }, { scope: undefined }, { requestId: 'random' },
  { scope: 'occurrence' }, { originalStartTime: '2030-01-01' }, { kind: 'event' }, { responseStatus: 'accepted' },
  { action: 'cancel' }, { action: 'invite', title: undefined }, { action: 'respond', title: undefined },
  { start: '2030-01-01T10:00:00-05:00', end: '2030-01-01T11:00:00-05:00' },
  { start: '2030-01-01', end: '2030-01-01', timeZone: 'UTC' },
  { start: '2030-02-30', end: '2030-03-01', timeZone: 'UTC' },
  { repeat: { frequency: 'weekly' } }, { scope: 'occurrence', recurringEventId: 'master', originalStartTime: '2030-01-01', repeat: null },
  { authorization: { intent: 'invite', recipients: ['not an email'] } }
])('invalid mutation does not touch provider or journal: %j', async changes => {
  const input = Object.fromEntries(Object.entries({ ...base, ...changes }).filter(([, value]) => value !== undefined));
  const provider = jest.fn();
  await expect(operate(input, { provider })).rejects.toBeDefined();
  expect(provider).not.toHaveBeenCalled();
  expect(await Operation.countDocuments()).toBe(0);
});

test('partial updates preserve untouched fields and distinguish clearing recurrence', () => {
  expect(request(base).patch).toEqual({ summary: base.title });
  expect(request({ ...base, scope: 'series', repeat: null, description: '', location: '', reminderMinutes: [] }).patch)
    .toEqual({ summary: base.title, recurrence: [], description: '', location: '', reminders: { useDefault: false, overrides: [] } });
});

test('moving retains explicit instants, household zone and native recurrence over both DST transitions', () => {
  for (const [start, end] of [['2030-03-03T10:00:00-05:00', '2030-03-03T11:00:00-05:00'], ['2030-10-27T10:00:00-04:00', '2030-10-27T11:00:00-04:00']]) {
    const payload = request({ ...base, scope: 'series', start, end, timeZone: 'America/Toronto', repeat: { frequency: 'weekly', count: 3 } });
    expect(payload.patch.start).toEqual({ dateTime: start, timeZone: 'America/Toronto' });
    expect(payload.patch.end.dateTime).toBe(end);
    expect(payload.patch.recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=3']);
  }
  expect(request({ ...base, start: '2030-11-03', end: '2030-11-05', timeZone: 'America/Toronto' }).patch.start).toEqual({ date: '2030-11-03' });
});

test('one durable dispatch, replay of the native result and changed-key conflict', async () => {
  const provider = jest.fn(async payload => receipt(payload));
  const first = await operate(base, { provider });
  const again = await operate({ ...base, requestId: base.requestId.toUpperCase() }, { provider });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(first.operationReceipt).toMatchObject({ requestId: base.requestId, expectedEtag: '"v1"', state: 'completed' });
  expect(again).toMatchObject({ replayed: true, eventObservation: 'recorded_result', event: first.event });
  await expect(operate({ ...base, title: 'Other' }, { provider })).rejects.toMatchObject({ code: 'PERSONAL_CALENDAR_ID_CONFLICT' });
});

test('concurrent retries cannot dispatch a second write even while the first is in flight', async () => {
  let writes = 0;
  const provider = jest.fn(async payload => {
    if (payload.reconcileOnly) throw Object.assign(new Error('No marker yet'), { code: 'PERSONAL_CALENDAR_UNCERTAIN' });
    writes++;
    await new Promise(resolve => setTimeout(resolve, 40));
    return receipt(payload);
  });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => operate(base, { provider })));
  expect(writes).toBe(1);
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  expect(await Operation.countDocuments()).toBe(1);
});

test('transport loss reconciles read-only under the exact original identity', async () => {
  const provider = jest.fn(async payload => {
    if (!payload.reconcileOnly) throw Object.assign(new Error('Lost response'), { code: 'PERSONAL_CALENDAR_TRANSPORT_UNCERTAIN' });
    return { ...receipt(payload), replayed: true, eventObservation: 'current_read' };
  });
  await expect(operate(base, { provider })).rejects.toMatchObject({ code: 'PERSONAL_CALENDAR_TRANSPORT_UNCERTAIN' });
  expect((await Operation.findById(base.requestId)).state).toBe('uncertain');
  expect(await operate(base, { provider })).toMatchObject({ replayed: true, operationReceipt: { state: 'completed' } });
  expect(provider.mock.calls.map(([payload]) => payload.reconcileOnly)).toEqual([false, true]);
});

test('absence of a marker and malformed success stay uncertain without relaunch', async () => {
  const provider = jest.fn(async payload => payload.reconcileOnly ? Promise.reject(new Error('Still unknown')) : { event: { id: 'wrong' } });
  await expect(operate(base, { provider })).rejects.toMatchObject({ code: 'PERSONAL_CALENDAR_UNCERTAIN' });
  await expect(operate(base, { provider })).rejects.toThrow('Still unknown');
  expect((await Operation.findById(base.requestId)).state).toBe('uncertain');
  expect(provider.mock.calls.map(([payload]) => payload.reconcileOnly)).toEqual([false, true]);
});

test.each(['PERSONAL_CALENDAR_CONFLICT', 'PERSONAL_CALENDAR_RATE_LIMITED'])('a proven refusal %s is retained and never retried as a new write', async code => {
  const provider = jest.fn(async () => { throw Object.assign(new Error('Refused before execution'), { code }); });
  for (let n = 0; n < 2; n++) await expect(operate(base, { provider })).rejects.toMatchObject({ code });
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await Operation.findById(base.requestId)).state).toBe('refused');
});

test('invite normalizes exact recipients, and respond uses the same shared MCP path', async () => {
  const { title, ...target } = base;
  const invitation = request({ ...target, action: 'invite', addAttendees: ['Synthetic@example.test'],
    authorization: { intent: 'invite', recipients: ['Synthetic@example.test'] } });
  expect(invitation.addAttendees).toEqual(['synthetic@example.test']);
  expect(invitation.authorization.recipients).toEqual(['synthetic@example.test']);
  const provider = jest.fn(async payload => receipt(payload));
  const result = await callSecretaryTool('personal_calendar', { ...target, requestId: randomUUID(), action: 'respond', responseStatus: 'tentative',
    authorization: { intent: 'respond', recipients: ['organizer@example.test'] } }, { calendar: { operate: input => operate(input, { provider }) } });
  expect(result).toMatchObject({ isError: false, structuredContent: { authority: 'google.calendar', operationReceipt: { action: 'respond' } } });
});

test('loss of the Core receipt after a native success still permits read-only reconciliation only', async () => {
  const update = jest.spyOn(Operation, 'updateOne').mockRejectedValueOnce(new Error('Synthetic journal outage'));
  const provider = jest.fn(async payload => ({ ...receipt(payload), replayed: payload.reconcileOnly }));
  try {
    await expect(operate(base, { provider })).rejects.toThrow('Synthetic journal outage');
    expect((await Operation.findById(base.requestId)).state).toBe('uncertain');
    expect(await operate(base, { provider })).toMatchObject({ replayed: true, operationReceipt: { state: 'completed' } });
    expect(provider.mock.calls.map(([payload]) => payload.reconcileOnly)).toEqual([false, true]);
  } finally { update.mockRestore(); }
});
