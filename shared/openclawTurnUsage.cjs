'use strict';

const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
const count = value => Number.isSafeInteger(value) && value >= 0;

// sessions.get is bounded. Only sum when the beginning of this exact run is
// still present, every assistant call reports usage, and its final reply is
// terminal. A continuation/delegation or a truncated prefix stays unknown.
function openclawTurnUsage(history, sessionKey, runId) {
  if (history?.sessionKey !== sessionKey || !Array.isArray(history.messages) || history.truncated === true) return null;
  const messages = history.messages;
  const indexes = messages.flatMap((row, index) => row?.role === 'assistant' && row.__openclaw?.runId === runId ? [index] : []);
  if (!indexes.length || indexes[0] === 0 || messages[indexes[0] - 1]?.role !== 'user') return null;
  const last = messages[indexes.at(-1)];
  if (last.stopReason !== 'stop' || last.phase === 'commentary') return null;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const seen = new Set();
  for (const index of indexes) {
    const row = messages[index], id = row.__openclaw.id;
    if (typeof id !== 'string' || !id || seen.has(id)) return null;
    seen.add(id);
    if (fields.some(key => !count(row.usage?.[key]))) return null;
    for (const key of fields) usage[key] += row.usage[key];
    if (fields.some(key => !count(usage[key]))) return null;
  }
  usage.total = fields.reduce((sum, key) => sum + usage[key], 0);
  return count(usage.total) ? usage : null;
}

module.exports = { openclawTurnUsage };
