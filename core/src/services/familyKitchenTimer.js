'use strict';

const { randomUUID } = require('node:crypto');
const KEY = 'family';
const ALERT_WINDOW_MS = 60_000;

function createFamilyKitchenTimer({ mongoose, now = Date.now, makeId = randomUUID }) {
  const name = 'AgentXFamilyKitchenTimer';
  const Timer = mongoose.models[name] || mongoose.model(name, new mongoose.Schema({
    _id: String, timerId: String, durationSeconds: Number, endsAt: Number, cancelledAt: Number, alertClaimedAt: Number,
    startRequestId: String, extensionRequests: [String]
  }, { versionKey: false }), 'household_kitchen_timers');

  function view(row, serverNow = now()) {
    if (!row || row.cancelledAt != null) return { state: 'idle', serverNow };
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
    signal?.throwIfAborted();
    const at = now();
    if (action === 'start') {
      try {
        const row = await Timer.findOneAndUpdate({ _id: KEY, startRequestId: { $ne: requestId },
          $or: [{ endsAt: { $lte: at } }, { cancelledAt: { $ne: null } }] },
          { $set: { timerId: makeId(), endsAt: at + seconds * 1000, durationSeconds: seconds, cancelledAt: null,
            alertClaimedAt: null, startRequestId: requestId, extensionRequests: [] } }, { upsert: true, new: true }).lean();
        const timer = view(row);
        return result('started', words.started + ' ' + (timer.state === 'running' ? remaining(timer, language) : words.done), timer);
      } catch (error) {
        if (error.code !== 11000) throw error;
        const timer = await read();
        return result('unchanged', timer.state === 'running' ? words.running + ' ' + remaining(timer, language)
          : timer.state === 'finished' ? words.done : words.none, timer);
      }
    }
    const row = await Timer.findById(KEY).lean();
    const timer = view(row);
    const statusText = timer.state === 'running' ? remaining(timer, language) : timer.state === 'finished' ? words.done : words.none;
    if (action === 'status') return result('status', statusText, timer);
    if (timer.state !== 'running') return result('unchanged', words.none, timer);
    const when = now();
    const filter = { _id: KEY, timerId: timer.id, cancelledAt: null, endsAt: { $gt: when } };
    signal?.throwIfAborted();
    if (action === 'cancel') {
      const updated = await Timer.findOneAndUpdate(filter, { $set: { cancelledAt: when } }, { new: true }).lean();
      return updated ? result('cancelled', words.cancelled, view(updated)) : result('unchanged', words.unavailable, await read());
    }
    const requests = row.extensionRequests || [];
    if (requests.includes(requestId)) return result('unchanged', statusText, timer);
    if (requests.length >= 128 || row.endsAt + seconds * 1000 - when > 86_400_000)
      return result('unchanged', language === 'en' ? 'No time was added to the timer.' : "Je n'ai pas ajouté de temps à la minuterie.", timer);
    // Compare the deadline used to compute the update. A concurrent change
    // is not retried against a different state or a replacement timer.
    const updated = await Timer.findOneAndUpdate({ ...filter, endsAt: { $eq: row.endsAt, $gt: when } },
      { $set: { endsAt: row.endsAt + seconds * 1000, durationSeconds: row.durationSeconds + seconds,
        extensionRequests: [...requests, requestId] } }, { new: true }).lean();
    if (!updated) return result('unchanged', language === 'en' ? 'No time was added to the timer.' : "Je n'ai pas ajouté de temps à la minuterie.", await read());
    const extended = view(updated);
    return result('extended', extended.state === 'running' ? remaining(extended, language) : words.done, extended);
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
