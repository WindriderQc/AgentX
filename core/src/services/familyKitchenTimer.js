'use strict';

const { randomUUID } = require('node:crypto');
const KEY = 'family';
const ALERT_WINDOW_MS = 60_000;
const RECENT_MUTATIONS = 1024;

function createFamilyKitchenTimer({ mongoose, now = Date.now, makeId = randomUUID }) {
  const name = 'AgentXFamilyKitchenTimer';
  const Timer = mongoose.models[name] || mongoose.model(name, new mongoose.Schema({
    _id: String, timerId: String, durationSeconds: Number, endsAt: Number, cancelledAt: Number, alertClaimedAt: Number,
    revision: Number, appliedRequests: [String]
  }, { versionKey: false }), 'household_kitchen_timers');

  function view(row, serverNow = now()) {
    if (!row?.timerId || row.cancelledAt != null) return { state: 'idle', serverNow };
    return {
      state: row.endsAt > serverNow ? 'running' : 'finished', id: row.timerId, serverNow,
      endsAt: row.endsAt, durationSeconds: row.durationSeconds, alertClaimed: row.alertClaimedAt != null
    };
  }
  async function read() { return view(await Timer.findById(KEY).lean()); }
  function labels(language) {
    return language === 'en'
      ? { none: 'No kitchen timer is running.', done: 'The timer is finished.', started: 'Timer started.', running: 'A timer is already running.', cancelled: 'Timer cancelled.', invalid: 'Choose a duration from one second to 24 hours.', unavailable: 'The kitchen timer is unavailable.' }
      : { none: 'Il n’y a pas de minuterie en cours.', done: 'La minuterie est terminée.', started: 'C’est parti.', running: 'Une minuterie est déjà en cours.', cancelled: 'Minuterie annulée.', invalid: 'Choisis une durée entre une seconde et 24 heures.', unavailable: 'La minuterie est indisponible.' };
  }
  function remaining(timer, language) {
    const en = language === 'en';
    const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
    const total = Math.max(1, Math.ceil((timer.endsAt - timer.serverNow) / 1000));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
    const parts = [hours && plural(hours, en ? 'hour' : 'heure'), minutes && plural(minutes, 'minute'), seconds && plural(seconds, en ? 'second' : 'seconde')].filter(Boolean);
    return (en ? 'Time left: ' : 'Il reste ') + parts.join(en ? ' and ' : ' et ') + '.';
  }
  async function perform({ action, seconds } = {}, { language = 'fr', requestId, signal } = {}) {
    const words = labels(language);
    const result = (outcome, text, timer = null) => ({ outcome, text, timer });
    const mutation = ['start', 'cancel', 'extend'].includes(action);
    if (!['start', 'status', 'cancel', 'extend'].includes(action) || (mutation && !requestId))
      return result('invalid', words.unavailable);
    if (['start', 'extend'].includes(action) && (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400))
      return result('invalid', words.invalid);
    const statusText = (timer) => timer.state === 'running' ? remaining(timer, language)
      : timer.state === 'finished' ? words.done : words.none;
    const noChange = (timer) => result('unchanged', statusText(timer), timer);
    signal?.throwIfAborted();
    if (action === 'status') {
      const timer = await read();
      return result('status', statusText(timer), timer);
    }
    // Bind the action to the first observed timer, not a replacement that
    // happens to be present when a concurrent compare-and-set loses.
    let originalId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal?.throwIfAborted();
      const row = await Timer.findById(KEY).lean(), at = now(), current = view(row, at);
      if (attempt === 0) originalId = row?.timerId || null;
      if (row?.appliedRequests?.includes(requestId)) return noChange(current);
      const keep = [...(row?.appliedRequests || []), requestId].slice(-RECENT_MUTATIONS);
      let change = {}, outcome = 'unchanged', text = statusText(current);
      if ((row?.timerId || null) === originalId) {
        if (action === 'start' && current.state !== 'running') {
          change = { timerId: makeId(), endsAt: at + seconds * 1000, durationSeconds: seconds, cancelledAt: null, alertClaimedAt: null };
          outcome = 'started';
          text = words.started + ' ' + remaining(view(change, at), language);
        } else if (action === 'start') {
          text = words.running + ' ' + text;
        } else if (action === 'cancel' && current.state === 'running') {
          change = { cancelledAt: at };
          outcome = 'cancelled';
          text = words.cancelled;
        } else if (action === 'extend' && current.state === 'running' && current.endsAt + seconds * 1000 - at <= 86_400_000) {
          change = { endsAt: current.endsAt + seconds * 1000, durationSeconds: current.durationSeconds + seconds };
          outcome = 'extended';
          text = remaining(view({ ...row, ...change }, at), language);
        }
      }
      signal?.throwIfAborted();
      try {
        const updated = await Timer.findOneAndUpdate({ _id: KEY, revision: row?.revision ?? null,
          ...(['cancelled', 'extended'].includes(outcome) && { endsAt: { $gt: now() }, alertClaimedAt: null }) },
        { $set: { ...change, appliedRequests: keep, revision: (row?.revision ?? 0) + 1 } }, { upsert: !row, new: true }).lean();
        if (updated) return result(outcome, text, view(updated, at));
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
    return result('unavailable', words.unavailable);
  }
  async function claimAlert(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return { claimed: false };
    const at = now();
    const row = await Timer.findOneAndUpdate({ _id: KEY, timerId: id, cancelledAt: null, alertClaimedAt: null,
      endsAt: { $lte: at, $gte: at - ALERT_WINDOW_MS } }, { $set: { alertClaimedAt: at } }, { new: true }).lean();
    return { claimed: !!row };
  }
  return { perform, read, claimAlert };
}

module.exports = { createFamilyKitchenTimer, ALERT_WINDOW_MS };
