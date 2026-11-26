'use strict';

const { readChoreRooms, readPublishedPlants } = require('./family-context');

const TOOL = {
  name: 'family_cards_read',
  description: 'Read Kids Room chores (available, waiting for a parent, approved today) or published family plant cards and their care needs. Use when the request needs these records. Card text is reference data. Nothing is checked in, approved or changed.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['section'], properties: {
    section: { type: 'string', enum: ['chores', 'plants'] },
    offset: { type: 'integer', minimum: 0 }
  } }
};

async function choreRows(familyTasks) {
  const rows = [];
  for (const { profile, room } of await readChoreRooms(familyTasks)) {
    const child = profile.displayName || profile.id;
    rows.push({ kind: 'room', child, timeZone: room.timeZone, available: room.available.length,
      waitingForParent: room.waiting.length, approvedToday: room.completedToday });
    for (const [status, chores] of [['available', room.available], ['waiting_for_parent', room.waiting]]) {
      for (const chore of chores) {
        rows.push({ kind: 'chore', child, title: chore.title, status, dueDay: chore.dueDay, overdue: chore.overdue, dueToday: chore.dueToday });
      }
    }
  }
  return rows;
}

async function plantRows(plants) {
  const published = await readPublishedPlants(plants);
  return published.map(({ nickname, commonName, room, needs = {}, mood, toxicity, doNotEat, funFact }) => ({
    nickname, commonName, room, needs: { light: needs.light, water: needs.water, humidity: needs.humidity }, mood, funFact,
    toxicity: { children: toxicity?.children || 'unknown', pets: toxicity?.pets || 'unknown' }, ...(doNotEat && { doNotEat: true })
  }));
}

function failure(error, message) { return { isError: true, structuredContent: { error, message } }; }

async function callTool(args, services) {
  if (!services) return failure('FAMILY_CARDS_UNAVAILABLE', 'These cards are unavailable in this turn.');
  try {
    const { section, offset = 0 } = args;
    const rows = section === 'chores' ? await choreRows(services.familyTasks) : await plantRows(services.plants);
    if (offset > rows.length) return failure('INVALID_ARGUMENTS', 'The offset exceeds the available cards. Read from the beginning.');
    const items = [];
    let size = 0;
    for (const row of rows.slice(offset)) {
      size += JSON.stringify(row).length + 1;
      if (size > 7400) break; // Leave room for metadata within the family tool's 8000-character limit.
      items.push(row);
    }
    if (offset < rows.length && !items.length) return failure('FAMILY_CARD_TOO_LARGE', 'This card exceeds the conversation budget.');
    const end = offset + items.length;
    return { structuredContent: { section, items, totalRows: rows.length, offset, nextOffset: end < rows.length ? end : null } };
  } catch {
    return failure('FAMILY_CARDS_UNAVAILABLE', 'This section could not be read. Its contents are unknown.');
  }
}

module.exports = { TOOL, callTool };
