'use strict';
const { createHash } = require('crypto');
const Operation = require('../../models/PersonalCalendarOperation');
const { normalizeRepeat, repeatRule } = require('./personalRepeat');
const MUTATIONS = new Set(['update', 'cancel', 'invite', 'respond']);
const fail = (message, code = 'PERSONAL_CALENDAR_INVALID') => Object.assign(new Error(message), { code, status: 400 });
const digest = value => createHash('sha256').update(value).digest('hex');
const has = (object, key) => Object.hasOwn(object, key);

function mutationRequest(input, base, date) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId || '')) throw fail('A stable UUID requestId is required.');
  if (!/^[a-zA-Z0-9_@.-]{1,1024}$/.test(input.eventId || '')) throw fail('An exact Google eventId is required.');
  if (!/^"[^"\r\n]{1,200}"$/.test(input.expectedEtag || '')) throw fail('Read the event and retain its exact quoted expectedEtag.');
  if (!input.scope) throw fail('Choose event, occurrence or series explicitly.');
  if (input.scope === 'occurrence' && (!input.recurringEventId || !input.originalStartTime)) throw fail('An occurrence requires recurringEventId and originalStartTime from Google.');
  if (input.scope !== 'occurrence' && (input.recurringEventId || input.originalStartTime)) throw fail('Occurrence identity is only valid with occurrence scope.');
  const allowed = new Set(['action', 'calendarId', 'eventId', 'requestId', 'expectedEtag', 'scope', 'recurringEventId',
    'originalStartTime', 'title', 'description', 'location', 'start', 'end', 'timeZone', 'repeat', 'reminderMinutes',
    'authorization', 'addAttendees', 'removeAttendees', 'responseStatus']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw fail('Unsupported fields for an existing event.');
  const patch = {};
  if (input.action === 'update') {
    for (const [key, target] of [['title', 'summary'], ['description', 'description'], ['location', 'location']]) {
      if (has(input, key)) patch[target] = key === 'title' ? input[key].trim() : input[key];
    }
    if (patch.summary === '') throw fail('title cannot be blank.');
    if (has(input, 'start') || has(input, 'end') || has(input, 'timeZone')) {
      if (!input.start || !input.end || !input.timeZone) throw fail('Moving an event requires start, end and timeZone together.');
      try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(); } catch { throw fail('Invalid time zone.'); }
      const start = date(input.start), end = date(input.end);
      if (!!start.date !== !!end.date || Date.parse(input.end) <= Date.parse(input.start)) throw fail('End must follow start using the same date form.');
      patch.start = { ...start, ...(start.dateTime ? { timeZone: input.timeZone } : {}) };
      patch.end = { ...end, ...(end.dateTime ? { timeZone: input.timeZone } : {}) };
    }
    if (has(input, 'repeat')) {
      if (input.scope === 'occurrence') throw fail('An occurrence cannot replace series recurrence.');
      if (input.repeat) {
        if (!input.start || !input.timeZone) throw fail('Changing repetition requires explicit dates and timeZone.');
        const repeat = normalizeRepeat({ ...input.repeat, timeZone: input.repeat.timeZone || input.timeZone });
        if (repeat.timeZone !== input.timeZone || (repeat.until && Date.parse(repeat.until) < Date.parse(input.start))) throw fail('Repetition must agree with the event dates and time zone.');
        patch.recurrence = [repeatRule(repeat)];
      } else patch.recurrence = [];
    }
    if (has(input, 'reminderMinutes')) patch.reminders = { useDefault: false, overrides: input.reminderMinutes.map(minutes => ({ method: 'popup', minutes })) };
    if (!Object.keys(patch).length) throw fail('Supply at least one event change.');
  }
  if (input.action === 'cancel') patch.status = 'cancelled';
  const emails = values => (values || []).map(value => value.toLowerCase()).sort();
  const addAttendees = emails(input.addAttendees), removeAttendees = emails(input.removeAttendees);
  if (new Set(addAttendees).size !== addAttendees.length || new Set(removeAttendees).size !== removeAttendees.length) throw fail('Duplicate attendees.');
  if (input.action === 'invite' && (!addAttendees.length && !removeAttendees.length || addAttendees.some(value => removeAttendees.includes(value)))) throw fail('Supply distinct attendees to add or remove.');
  if (input.action === 'respond' && !input.responseStatus) throw fail('Choose accepted, tentative or declined.');
  // Reject fields belonging to another action instead of silently widening or losing intent.
  const changes = ['title', 'description', 'location', 'start', 'end', 'timeZone', 'repeat', 'reminderMinutes'];
  if (input.action !== 'update' && changes.some(key => has(input, key))) throw fail('Event changes require update.');
  if (input.action !== 'invite' && (has(input, 'addAttendees') || has(input, 'removeAttendees'))) throw fail('Attendee changes require invite.');
  if (input.action !== 'respond' && has(input, 'responseStatus')) throw fail('responseStatus requires respond.');
  const authorization = input.authorization ? { intent: input.authorization.intent, recipients: emails(input.authorization.recipients) } : null;
  if (authorization && new Set(authorization.recipients).size !== authorization.recipients.length) throw fail('Duplicate authorization recipients.');
  const payload = { ...base, eventId: input.eventId, requestId: input.requestId.toLowerCase(), expectedEtag: input.expectedEtag,
    scope: input.scope, patch, authorization,
    ...(input.scope === 'occurrence' ? { recurringEventId: input.recurringEventId, originalStartTime: date(input.originalStartTime) } : {}),
    ...(input.action === 'invite' ? { addAttendees, removeAttendees } : {}),
    ...(input.action === 'respond' ? { responseStatus: input.responseStatus } : {}) };
  return { ...payload, fingerprint: digest(JSON.stringify(payload)), marker: `axm${input.requestId.replace(/-/g, '').toLowerCase()}` };
}

async function mutate(payload, provider) {
  // _id is the durable dispatch fence. No TTL: expiration must never authorize a replay.
  let first = false;
  try {
    await Operation.create({ _id: payload.requestId, fingerprint: payload.fingerprint, state: 'uncertain',
      action: payload.action, calendarId: payload.calendarId, eventId: payload.eventId, scope: payload.scope });
    first = true;
  } catch (error) { if (error.code !== 11000) throw error; }
  const row = await Operation.findById(payload.requestId).lean();
  if (row.fingerprint !== payload.fingerprint) throw fail('This requestId belongs to another calendar operation.', 'PERSONAL_CALENDAR_ID_CONFLICT');
  if (row.state === 'completed') return { ...row.result, replayed: true, eventObservation: 'recorded_result' };
  if (row.state === 'refused') throw fail(row.error.message, row.error.code);
  let result;
  try { result = await provider({ ...payload, reconcileOnly: !first }); }
  catch (error) {
    const terminal = new Set(['PERSONAL_CALENDAR_INVALID', 'PERSONAL_CALENDAR_CONFLICT', 'PERSONAL_CALENDAR_CANCELLED',
      'PERSONAL_CALENDAR_AUTHORIZATION', 'PERSONAL_CALENDAR_RATE_LIMITED', 'PERSONAL_CALENDAR_GUEST_AUTHORIZATION_REQUIRED', 'PERSONAL_CALENDAR_NOT_FOUND']);
    if (first && terminal.has(error.code)) await Operation.updateOne({ _id: payload.requestId, state: 'uncertain' },
      { $set: { state: 'refused', error: { code: error.code, message: error.message } } });
    throw error;
  }
  if (!result?.event || result.event.id !== payload.eventId || result.mutationObserved !== true) throw fail('No matching native operation receipt; retain the same requestId.', 'PERSONAL_CALENDAR_UNCERTAIN');
  const receipt = { ...result, requestId: payload.requestId, operationReceipt: {
    contract: 'agentx.personal-calendar-operation/v1', requestId: payload.requestId,
    action: payload.action, calendarId: payload.calendarId, eventId: payload.eventId, scope: payload.scope,
    expectedEtag: payload.expectedEtag, observedEtag: result.event.etag || null, state: 'completed' } };
  await Operation.updateOne({ _id: payload.requestId, state: 'uncertain' }, { $set: { state: 'completed', result: receipt } });
  return receipt;
}
module.exports = { MUTATIONS, mutationRequest, mutate };
