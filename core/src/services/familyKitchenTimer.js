'use strict';

const { randomUUID } = require('node:crypto');
const { parse } = require('./familyKitchenTimerCommand');
const KEY = 'family';
const ALERT_WINDOW_MS = 60_000;

function createFamilyKitchenTimer({ mongoose, now = Date.now, makeId = randomUUID }) {
  const name = 'AgentXFamilyKitchenTimer';
  const Timer = mongoose.models[name] || mongoose.model(name, new mongoose.Schema({
    _id: String, timerId: String, durationSeconds: Number, endsAt: Number, cancelledAt: Number, alertClaimedAt: Number
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
  async function command(text, language = 'fr') {
    const intent = parse(text), words = labels(language);
    const result = (reply, timer) => ({ handled: true, reply: { text: reply, language }, timer });
    if (!intent) return { handled: false };
    const at = now();
    if (intent.action === 'start') {
      const timerId = makeId();
      const endsAt = at + intent.seconds * 1000;
      try {
        const row = await Timer.findOneAndUpdate({ _id: KEY, $or: [{ endsAt: { $lte: at } }, { cancelledAt: { $ne: null } }] },
          { $set: { timerId, endsAt, durationSeconds: intent.seconds, cancelledAt: null, alertClaimedAt: null } },
          { upsert: true, new: true }).lean();
        const timer = view(row);
        return result(words.started + ' ' + (timer.state === 'running' ? remaining(timer, language) : words.done), timer);
      } catch (error) {
        if (error.code !== 11000) throw error;
        const timer = await read();
        return result(timer.state === 'running' ? words.running + ' ' + remaining(timer, language) : words.none, timer);
      }
    }
    if (intent.action === 'cancel') {
      const current = await read();
      if (current.state !== 'running') return result(words.none, current);
      const row = await Timer.findOneAndUpdate({ _id: KEY, timerId: current.id, cancelledAt: null, endsAt: { $gt: now() } },
        { $set: { cancelledAt: now() } }, { new: true }).lean();
      return row ? result(words.cancelled, view(row)) : result(words.none, await read());
    }
    const timer = await read();
    if (intent.action === 'invalid') return result(words.invalid, timer);
    if (timer.state === 'running') return result(remaining(timer, language), timer);
    if (!intent.explicit && !(timer.state === 'finished' && timer.serverNow - timer.endsAt < ALERT_WINDOW_MS)) return { handled: false, timer };
    return result(timer.state === 'finished' ? words.done : words.none, timer);
  }
  async function claimAlert(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return { claimed: false };
    const at = now();
    const row = await Timer.findOneAndUpdate({ _id: KEY, timerId: id, cancelledAt: null, alertClaimedAt: null,
      endsAt: { $lte: at, $gte: at - ALERT_WINDOW_MS } }, { $set: { alertClaimedAt: at } }, { new: true }).lean();
    return { claimed: !!row };
  }
  async function turnReply(text, language) {
    if (!parse(text)) return null;
    try {
      const result = await command(text, language);
      return result.handled ? { text: result.reply.text, timer: result.timer } : null;
    } catch {
      return { text: labels(language).unavailable, timer: null };
    }
  }
  return { command, read, claimAlert, turnReply };
}

module.exports = { createFamilyKitchenTimer, ALERT_WINDOW_MS };
