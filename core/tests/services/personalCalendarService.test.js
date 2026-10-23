'use strict';
const { request, operate } = require('../../src/services/personalCalendarService');
const { nextPersonalOccurrence } = require('../../src/services/personalRepeat');
const { callSecretaryTool, SECRETARY_TOOLS } = require('../../surfaces/household/secretary-mcp');
const ID = 'e721c84c-bc26-4a58-889b-40de7dc10bac';
const event = { action: 'create', requestId: ID, title: 'Synthetic appointment',
  start: '2030-10-25T10:00:00-04:00', end: '2030-10-25T11:00:00-04:00', timeZone: 'America/Toronto' };

test('Google receives one native recurring series with configured popup reminders', async () => {
  const payload = request({ ...event, repeat: { frequency: 'weekly', weekdays: ['FR'], count: 4 }, reminderMinutes: [15, 60] });
  expect(payload.body).toMatchObject({ start: { timeZone: 'America/Toronto' },
    recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR;COUNT=4'],
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }, { method: 'popup', minutes: 60 }] } });
  expect(payload.eventId).toMatch(/^[a-f0-9]{64}$/);
  expect(request(event).eventId).toBe(payload.eventId);
  expect(request(event).fingerprint).not.toBe(payload.fingerprint);
  expect(request({ ...event, requestId: ID.toUpperCase() }).eventId).toBe(payload.eventId);
});

test('a reminder is a free event with a real Google popup, not an unnotified task', () => {
  const payload = request({ action: 'create', kind: 'reminder', requestId: ID, title: 'Synthetic reminder', start: event.start });
  expect(payload.body).toMatchObject({ transparency: 'transparent', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    end: { dateTime: '2030-10-25T14:01:00.000Z' } });
});

test.each([
  { ...event, requestId: undefined }, { ...event, start: 'tomorrow' },
  { ...event, end: '2030-10-25' }, { ...event, start: '2030-02-30T10:00:00Z' },
  { ...event, timeZone: 'invalid/zone' }, { ...event, repeat: { frequency: 'hourly' } },
  { ...event, repeat: { frequency: 'weekly', until: '2020-01-01T00:00:00Z' } },
  { action: 'list' }, { action: 'list', timeMin: '2030-01-01T00:00:00Z', timeMax: '2032-01-01T00:00:00Z' },
  { ...event, attendees: ['unrequested@example.test'] }
])('invalid input refuses before provider execution: %j', async input => {
  const provider = jest.fn();
  await expect(operate(input, { provider })).rejects.toBeDefined();
  expect(provider).not.toHaveBeenCalled();
});

test('all-day boundaries stay date-only and empty reminders disable defaults', () => {
  expect(request({ ...event, start: '2030-10-25', end: '2030-10-26', reminderMinutes: [] }).body)
    .toMatchObject({ start: { date: '2030-10-25' }, end: { date: '2030-10-26' }, reminders: { useDefault: false, overrides: [] } });
});

test('the common MCP adapter exposes the service and preserves uncertain results', async () => {
  expect(SECRETARY_TOOLS.some(tool => tool.name === 'personal_calendar')).toBe(true);
  const service = { operate: input => operate(input, { provider: async () => ({ event: { id: 'synthetic' }, replayed: true }) }) };
  expect(await callSecretaryTool('personal_calendar', event, { calendar: service })).toMatchObject({ isError: false,
    structuredContent: { authority: 'google.calendar', requestId: ID, replayed: true, event: { id: 'synthetic' } } });
  const failure = Object.assign(new Error('Retain the same requestId.'), { code: 'PERSONAL_CALENDAR_UNCERTAIN' });
  expect(await callSecretaryTool('personal_calendar', event, { calendar: { operate: async () => { throw failure; } } }))
    .toMatchObject({ isError: true, structuredContent: { error: 'PERSONAL_CALENDAR_UNCERTAIN' } });
});

test('task repetitions preserve wall time across DST in every process zone, month ends and count limits', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Toronto', 'Europe/Paris']) {
      process.env.TZ = zone;
      expect(nextPersonalOccurrence({ frequency: 'weekly', timeZone: 'America/Toronto' }, '2030-03-03T15:00:00Z', '2030-03-03T15:00:00Z').toISOString()).toBe('2030-03-10T14:00:00.000Z');
      expect(nextPersonalOccurrence({ frequency: 'weekly', timeZone: 'America/Toronto' }, '2030-10-27T14:00:00Z', '2030-10-27T14:00:00Z').toISOString()).toBe('2030-11-03T15:00:00.000Z');
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  expect(nextPersonalOccurrence({ frequency: 'monthly', timeZone: 'UTC' }, '2030-01-31T12:00:00Z', '2030-01-31T12:00:00Z').toISOString()).toBe('2030-03-31T12:00:00.000Z');
  expect(nextPersonalOccurrence({ frequency: 'daily', count: 1, timeZone: 'UTC' }, '2030-01-01T12:00:00Z', '2030-01-01T12:00:00Z')).toBeNull();
});
