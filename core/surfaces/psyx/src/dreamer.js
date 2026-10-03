'use strict';

const { dreamMessages, readDream } = require('../../../src/domains/psyx/dream');
const { familyTimeZone } = require('../../../src/domains/household/family');

// Runs the dream: once a session has gone quiet, every night when there is
// something new, and on request. One dream at a time per user. Like the review,
// an admitted inference is never cancelled; a result that is no longer wanted
// (memory reset, conversation deleted meanwhile) is discarded instead.
const BUDGETS = Object.freeze({
  local: { maxCharacters: 60000, sourceCharacters: 6000 },
  frontier: { maxCharacters: 300000, sourceCharacters: 30000 }
});
const REFRESH_MS = 7 * 86400000;

function createDreamer({ config, provider, stateRepository, conversationRepository, sources = null, logger = console, isBusy = () => false, locationFor = () => 'local', now = () => new Date() }) {
  const settings = config.dream || {};
  const enabled = settings.enabled !== false && typeof provider.complete === 'function' && typeof stateRepository.recordDream === 'function';
  const idleMs = settings.sessionIdleMs ?? 30 * 60000;
  const retryMs = settings.retryMs ?? 60000;
  const jobs = new Map();
  const job = userId => jobs.get(userId) || jobs.set(userId, { status: 'idle', epoch: 0, timer: null, pending: null }).get(userId);

  async function run(userId, kind, state) {
    const conversations = (await conversationRepository.listTranscripts(userId)).filter(item => item.messages?.some(message => message.role === 'user'))
      .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
    if (!conversations.length) return { skipped: 'nothing' };
    const through = conversations.at(-1).updatedAt || null;
    const portrait = state.portrait;
    // The night has nothing to add when no session moved since the last portrait, until it is a week old.
    if (kind === 'night' && portrait && String(through) <= String(portrait.covers.through || '')
      && now().getTime() - new Date(portrait.updatedAt).getTime() < REFRESH_MS) return { skipped: 'unchanged' };
    const location = locationFor(state);
    const gathered = sources ? await sources.gather({ now: now() }) : { sources: [], unavailable: [] };
    const epoch = job(userId).epoch;
    const messages = lane => dreamMessages({ state, conversations, sources: gathered.sources, kind, now: now(), ...BUDGETS[lane] });
    const result = await provider.complete({
      messages: messages(location === 'frontier' ? 'frontier' : 'local'),
      // If the frontier lane fails, the local route dreams over its own bounded material.
      local: location === 'frontier' ? { messages: messages('local') } : null,
      taskType: settings.taskType || 'deep_reasoning', timeoutMs: settings.timeoutMs || 600000, maxTurnMs: settings.timeoutMs || 600000,
      location, work: 'dream'
    });
    const dream = readDream(result.content, { state });
    if (!dream || !dream.sections.length) throw Object.assign(new Error('The dream returned no usable portrait'), { code: 'PSYX_DREAM_UNUSABLE' });
    const recorded = await stateRepository.recordDream(userId, {
      dream, kind, model: result.model || null, location: result.location === 'frontier' ? 'frontier' : 'local',
      sources: gathered.sources.map(source => source.key), covers: { conversations: conversations.length, through },
      resetAt: state.resetAt, stillWanted: () => job(userId).epoch === epoch
    });
    return recorded.skipped ? { skipped: recorded.skipped } : { entry: recorded.entry, model: result.model || null };
  }

  async function attempt(userId, kind) {
    const current = job(userId);
    if (current.status === 'running') { current.pending = current.pending || kind; return; }
    // Do not compete with a reply the user is waiting for.
    if (isBusy(userId)) return arm(userId, kind, retryMs);
    Object.assign(current, { status: 'running', kind, startedAt: now().toISOString(), error: null });
    try {
      const outcome = await run(userId, kind, await stateRepository.read(userId));
      Object.assign(current, { status: outcome.skipped ? 'idle' : 'done', skipped: outcome.skipped || null, model: outcome.model || null,
        lastEntry: outcome.entry || current.lastEntry || null, completedAt: now().toISOString() });
    } catch (error) {
      Object.assign(current, { status: 'failed', error: error.code || 'PSYX_DREAM_FAILED', completedAt: now().toISOString() });
      logger.warn?.('PsyX dream failed', { kind, code: error.code, message: error.message });
    }
    const pending = current.pending;
    current.pending = null;
    if (pending) arm(userId, pending, pending === 'session' ? idleMs : 0);
  }

  function arm(userId, kind, delayMs) {
    const current = job(userId);
    clearTimeout(current.timer);
    current.timer = setTimeout(() => { current.timer = null; void attempt(userId, kind); }, delayMs);
    current.timer.unref?.();
  }

  // A completed turn: dream about the session once it has been quiet for a while.
  function touch(userId) {
    if (!enabled) return false;
    const current = job(userId);
    if (current.status === 'running') current.pending = 'session';
    else arm(userId, 'session', idleMs);
    return true;
  }

  function request(userId) {
    if (!enabled) return false;
    arm(userId, 'manual', 0);
    return true;
  }

  // Something the portrait was built from is gone: start again from what remains.
  async function invalidate(userId) {
    if (!enabled) return;
    job(userId).epoch += 1;
    const { cleared } = await stateRepository.clearPortrait(userId);
    if (cleared) arm(userId, 'manual', retryMs);
  }

  function status(userId) {
    if (!enabled) return { enabled: false, status: 'disabled' };
    const { status: current, kind = null, error = null, model = null, completedAt = null, skipped = null, timer } = job(userId);
    return { enabled: true, status: current, scheduled: Boolean(timer), kind, error, model, completedAt, skipped };
  }

  // The nightly pass: checked a few times an hour, run once in the configured local hour.
  let nightKey = null;
  async function nightly() {
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: familyTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).format(now());
    const [date, hour] = local.split(', ');
    if (Number(hour) % 24 !== (settings.nightHour ?? 3) || nightKey === date) return;
    nightKey = date;
    for (const userId of await stateRepository.dreamUserIds()) arm(userId, 'night', 0);
  }
  let clock = null;
  function start() {
    if (!enabled || clock) return;
    clock = setInterval(() => void nightly().catch(error => logger.warn?.('PsyX nightly dream check failed', { message: error.message })), settings.clockMs ?? 10 * 60000);
    clock.unref?.();
  }
  function stop() {
    clearInterval(clock);
    clock = null;
    for (const current of jobs.values()) clearTimeout(current.timer);
  }

  return { enabled, touch, request, invalidate, status, start, stop, nightly };
}

module.exports = { createDreamer };
