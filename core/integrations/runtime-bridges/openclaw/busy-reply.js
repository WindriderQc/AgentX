'use strict';

// A conversation whose local host is busy gets an honest answer instead of a
// transport error. Callers opt in per provider with this header; automations
// (cron turns) keep the 409 so a skipped run is never recorded as a success.
const BUSY_REPLY_HEADER = 'x-agentx-busy-reply';
const BUSY_REPLY_MODE = 'conversation';
const TIME_ZONE = 'America/Toronto';

function mentions(value, pattern) {
  return pattern.test(String(value || ''));
}

function holderLabel(code, holder) {
  if (code === 'BENCHMARK_CLAIM_ACTIVE') return 'une campagne benchmark';
  if (!holder) return 'une autre charge de travail';
  const who = `${holder.kind || ''} ${holder.principal || ''}`;
  if (holder.type === 'maintenance') return 'une maintenance';
  if (mentions(who, /bench|judge/i)) return 'une campagne benchmark';
  if (mentions(who, /profil/i)) return 'une mesure du Profiler';
  if (holder.type === 'inference' && holder.model) return `un autre modèle (${holder.model})`;
  return holder.kind ? `une tâche réservée (${holder.kind})` : 'une autre charge de travail';
}

function sinceLabel(value, now) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const time = new Intl.DateTimeFormat('fr-CA', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date).replace(':', ' h ');
  const day = (instant) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(instant);
  return day(date) === day(now) ? ` depuis ${time}` : ` depuis le ${new Intl.DateTimeFormat('fr-CA', { timeZone: TIME_ZONE, day: 'numeric', month: 'long' }).format(date)} à ${time}`;
}

function busyMessage(error, now = new Date()) {
  const failure = error?.failure || {};
  if (error?.code === 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' || /recovery_required$/.test(failure.cause || '')) {
    return "⏸️ Je ne peux pas répondre pour le moment : le serveur d'inférence local attend une intervention après un incident (voir Agent Ops). Rien n'est envoyé vers le cloud.";
  }
  if (failure.cause === 'fallback_unavailable') {
    const { reasonLabel } = require('./conversation-fallback');
    return `⏸️ Je ne peux pas répondre pour le moment : le cerveau principal est ${reasonLabel({ reason: failure.primaryReason })} et le cerveau léger ne répond pas non plus. Rien n'est envoyé vers le cloud. Réessaie dans quelques minutes.`;
  }
  const holder = failure.holder || null;
  return `⏸️ Je ne peux pas répondre pour le moment : le serveur d'inférence local est occupé par ${holderLabel(error?.code, holder)}${sinceLabel(holder?.since, now)}. Rien n'est envoyé vers le cloud. Réessaie dans quelques minutes.`;
}

function wantsBusyReply(req, mode) {
  return mode !== 'embed'
    && String(req.get(BUSY_REPLY_HEADER) || '').trim().toLowerCase() === BUSY_REPLY_MODE;
}

// Native Ollama shapes, so the caller renders it as an ordinary final answer.
function sendBusyReply(res, { mode, model, stream, error, now = new Date() }) {
  const content = busyMessage(error, now);
  const base = { model: model || 'agentx', created_at: now.toISOString() };
  const final = mode === 'generate'
    ? { ...base, response: stream ? '' : content, done: true, done_reason: 'stop' }
    : { ...base, message: { role: 'assistant', content: stream ? '' : content }, done: true, done_reason: 'stop' };
  res.set('x-agentx-inference-outcome', 'host-busy');
  if (!stream) return res.status(200).json(final);
  const first = mode === 'generate'
    ? { ...base, response: content, done: false }
    : { ...base, message: { role: 'assistant', content }, done: false };
  res.status(200).type('application/x-ndjson');
  return res.end(`${JSON.stringify(first)}\n${JSON.stringify(final)}\n`);
}

module.exports = { BUSY_REPLY_HEADER, BUSY_REPLY_MODE, busyMessage, sendBusyReply, wantsBusyReply };
