'use strict';

// A published plant card keeps its Kids Room chores in step (#869): one family
// chore per care action assigned to a child, linked by subjectRef plant:<id> and
// sourceKey plant:<id>:<action key>. Editing the plan updates the open chores;
// removing or unassigning an action, or retiring the plant, cancels them. A
// chore a child has checked in is never changed under them.

const family = require('./familyTaskService');
const { calendarDayKey } = require('../domains/household/family');

const SOURCE = 'household-plant';
const FIELDS = Object.freeze(['title', 'note', 'profileId', 'cadence', 'intervalDays', 'winterIntervalDays', 'stars']);
const subjectOf = plantId => `plant:${plantId}`;
const keyOf = (plantId, actionKey) => `plant:${plantId}:${actionKey}`;
const closed = chore => ['done', 'cancelled'].includes(chore.status);

function routineOf(action) {
  return { title: action.title, note: action.note || '', profileId: action.profileId, cadence: action.cadence,
    intervalDays: action.intervalDays ?? null, winterIntervalDays: action.winterIntervalDays ?? null, stars: action.stars };
}

function changes(chore, routine) {
  return Object.fromEntries(FIELDS.filter(key => (chore[key] ?? null) !== (routine[key] ?? null)).map(key => [key, routine[key]]));
}

/** Brings the chores of one plant card in line with its status and care plan. */
async function syncPlantChores(plant, deps = {}) {
  const tasks = deps.family || family;
  const now = deps.now ? deps.now() : new Date();
  const id = String(plant._id || plant.id);
  const result = { created: [], updated: [], cancelled: [], unassigned: [], waiting: [], errors: [] };
  const { chores } = await tasks.listBySubject([subjectOf(id)], { includeClosed: true });
  const ours = new Map(chores.filter(chore => chore.source === SOURCE).map(chore => [chore.sourceKey, chore]));
  const plan = plant.status === 'published' ? plant.carePlan || [] : [];
  const wanted = new Set();
  for (const action of plan) {
    if (!action.profileId) { result.unassigned.push(action.title); continue; }
    const key = keyOf(id, action.key);
    wanted.add(key);
    const routine = routineOf(action), existing = ours.get(key);
    try {
      if (!existing) {
        const { chore } = await tasks.create({ ...routine, dueAt: calendarDayKey(now) }, { source: SOURCE, sourceKey: key, subjectRef: subjectOf(id) });
        result.created.push(chore.id);
      } else if (existing.status === 'review') {
        result.waiting.push(existing.id);
      } else {
        let current = existing;
        if (closed(existing)) ({ chore: current } = await tasks.reopen({ ref: existing.id }));
        const diff = changes(current, routine);
        if (closed(existing)) diff.dueAt = calendarDayKey(now);
        if (Object.keys(diff).length) {
          await tasks.update({ ref: current.id, expectedRevision: current.revision, ...diff });
          result.updated.push(current.id);
        }
      }
    } catch (error) {
      result.errors.push({ title: action.title, code: error.code || 'PLANT_CHORE_SYNC_FAILED' });
    }
  }
  for (const [key, chore] of ours) {
    if (wanted.has(key) || closed(chore)) continue;
    if (chore.status === 'review') { result.waiting.push(chore.id); continue; }
    try { await tasks.cancel({ ref: chore.id }); result.cancelled.push(chore.id); }
    catch (error) { result.errors.push({ title: chore.title, code: error.code || 'PLANT_CHORE_SYNC_FAILED' }); }
  }
  return result;
}

/** The open chores of these plants, grouped by plant id. */
async function choresByPlant(plantIds, deps = {}) {
  const tasks = deps.family || family;
  const ids = plantIds.map(String);
  if (!ids.length) return new Map();
  const { chores } = await tasks.listBySubject(ids.map(subjectOf));
  const grouped = new Map(ids.map(id => [id, []]));
  for (const chore of chores) grouped.get(String(chore.subjectRef).slice('plant:'.length))?.push(chore);
  return grouped;
}

module.exports = { SOURCE, choresByPlant, syncPlantChores };
