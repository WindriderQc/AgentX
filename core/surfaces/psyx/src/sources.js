'use strict';

// What the dream may read about the owner outside PsyX, read-only: the notes
// his assistant keeps, his open tasks and reminders, and the mail journal.
// Each source is optional; one that fails is reported, never fatal. Core has no
// calendar or custody schedule, so that rhythm only appears where a note says it.

const DAY = 86400000;
const day = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10); };
// Preserve each collected field; prepareDreamRequest owns the source budget
// and reports how much source text it includes.
const line = value => String(value || '').replace(/\s+/g, ' ').trim();

function createSources({ runtimeServices, mailJournal = null, logger = console, mailDays = 45 } = {}) {
  const readers = {
    async notes() {
      const space = runtimeServices?.memory?.notes?.personal?.();
      if (!space?.list) return null;
      const notes = [];
      let total = null, more = false, stalled = false;
      for (let offset = 0; offset != null && notes.length < 300;) {
        const page = await space.list({ limit: 100, offset });
        notes.push(...(page.notes || []));
        total = Number.isSafeInteger(page.total) ? page.total : total;
        more = page.truncated === true;
        stalled = more && !(page.nextOffset > offset);
        offset = more && !stalled ? page.nextOffset : null;
      }
      return { title: 'Notes his assistant keeps about him (facts, preferences, decisions)', count: notes.length,
        collection: { collectedItems: notes.length, availableItems: total ?? (!more ? notes.length : null),
          complete: !more, reason: stalled ? 'pagination_not_advancing' : more ? 'collection_limit' : null },
        text: notes.map(note => `- [${note.kind || 'fact'}, ${day(note.updatedAt)}] ${line(note.text)}`).join('\n') };
    },
    async tasks() {
      const list = runtimeServices?.tasks?.personal?.list;
      if (!list) return null;
      const result = await list({ limit: 100 });
      const tasks = result.tasks || [];
      // This API has a limit but no continuation/total. At the limit we cannot
      // tell whether all open tasks were collected.
      const complete = tasks.length < 100 ? true : null;
      return { title: `His open tasks and reminders (${result.overdueCount || 0} overdue)`, count: tasks.length,
        collection: { collectedItems: tasks.length, availableItems: complete ? tasks.length : null,
          complete, reason: complete ? null : 'collection_limit_total_unknown' },
        text: tasks.map(task => `- ${line(task.title)}${task.dueAt ? ` (due ${day(task.dueAt)}${task.overdue ? ', overdue' : ''})` : ''}`).join('\n') };
    },
    async mail(now) {
      if (!mailJournal?.search) return null;
      const entries = new Map();
      let until, total = null, more = false, stalled = false;
      for (let page = 0; page < 4; page += 1) {
        const result = await mailJournal.search({ since: new Date(now.getTime() - mailDays * DAY), limit: 50, ...(until ? { until } : {}) });
        if (page === 0 && Number.isSafeInteger(result.total)) total = result.total;
        for (const entry of result.entries || []) entries.set(entry.id, entry);
        const oldest = result.entries?.at(-1)?.occurredAt;
        more = result.truncated === true;
        stalled = more && (!oldest || String(oldest) === String(until));
        if (!more || stalled) break;
        until = oldest;
      }
      const complete = !more && (total == null || entries.size === total);
      return { title: `His mail journal, last ${mailDays} days (summaries written by his mail assistant)`, count: entries.size,
        collection: { collectedItems: entries.size, availableItems: total ?? (complete ? entries.size : null), complete,
          reason: stalled ? 'pagination_not_advancing' : more ? 'collection_limit' : complete ? null : 'collection_changed' },
        text: [...entries.values()].map(entry => `- ${day(entry.occurredAt)} | ${line(entry.counterpart)} | ${line(entry.subject)}: ${line(entry.summary)}`).join('\n') };
    }
  };

  // -> { sources: [{ key, title, text, count }], unavailable: [key] }
  async function gather({ now = new Date(), keys = Object.keys(readers) } = {}) {
    const sources = [], unavailable = [];
    for (const [key, reader] of Object.entries(readers)) {
      if (!keys.includes(key)) continue;
      try {
        const source = await reader(now);
        if (source?.text) sources.push({ key, ...source });
        else if (!source) unavailable.push(key);
      } catch (error) {
        unavailable.push(key);
        logger.warn?.('PsyX dream could not read a source', { source: key, message: error.message });
      }
    }
    return { sources, unavailable };
  }

  return { gather };
}

module.exports = { createSources };
