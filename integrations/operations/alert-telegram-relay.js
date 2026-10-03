#!/usr/bin/env node
'use strict';

/**
 * Alert Telegram relay.
 *
 * Core stores alerts and records per-channel delivery, but performs no network
 * delivery itself (notificationService answers ADAPTER_REQUIRED). This relay is
 * that adapter for Telegram: it reads active alerts whose rule lists the
 * `telegram` channel and whose Telegram delivery is not yet sent, posts each
 * one to a Telegram chat/topic, and records the outcome through
 * `POST /api/alerts/:id/delivery-status`. Core's re-notification resets the
 * Telegram delivery, so a reminder is relayed again on the next run.
 *
 * Default mode is a network-free preview for Telegram (Core is still read);
 * `--send` delivers. `--create-topic NAME` creates a forum topic once and
 * prints its id for the config file. The bot token is read from a private
 * file at run time and never printed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG = process.env.AGENTX_ALERT_TELEGRAM_CONFIG
  || path.join(os.homedir(), '.config', 'agentx', 'alert-telegram.json');
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.local', 'state', 'agentx', 'alert-telegram-relay.json');
const DEFAULT_CORE_URL = 'http://127.0.0.1:3180';
// A relayed alert is followed for a resolution notice for at most this long.
const RESOLUTION_WATCH_MS = 7 * 24 * 60 * 60 * 1000;
const TELEGRAM_API = 'https://api.telegram.org';
const MAX_TEXT = 3500;
const SEVERITY_LABELS = Object.freeze({
  critical: '🔴 CRITIQUE',
  error: '🟠 ERREUR',
  warning: '🟡 AVERTISSEMENT',
  info: '🔵 INFO',
});

function parseArgs(argv) {
  const options = { config: DEFAULT_CONFIG, coreUrl: null, send: false, json: false, createTopic: null, maxPerRun: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') options.config = path.resolve(argv[++i]);
    else if (arg === '--core-url') options.coreUrl = argv[++i];
    else if (arg === '--send') options.send = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--create-topic') options.createTopic = argv[++i];
    else if (arg === '--max') options.maxPerRun = Number.parseInt(argv[++i], 10);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node integrations/operations/alert-telegram-relay.js [options]',
    '',
    '  --config PATH         Relay config JSON (default ~/.config/agentx/alert-telegram.json).',
    '  --core-url URL        Core base URL (default from config, then http://127.0.0.1:3180).',
    '  --send                Deliver to Telegram and record delivery in Core. Without it: preview only.',
    '  --max N               Maximum alerts relayed per run (default from config, then 5).',
    '  --create-topic NAME   Create a forum topic in the configured chat and print its id.',
    '  --json                Print the run summary as JSON.',
  ].join('\n');
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('relay config must be a JSON object');
  if (!/^-?\d+$/.test(String(config.chatId || ''))) throw new Error('chatId must be a numeric Telegram chat id');
  if (config.topicId != null && !/^\d+$/.test(String(config.topicId))) throw new Error('topicId must be a numeric forum topic id');
  if (!config.tokenFile) throw new Error('tokenFile is required');
  if (config.tokenPointer != null && !String(config.tokenPointer).startsWith('/')) {
    throw new Error('tokenPointer must be a JSON pointer such as /openclaw/channels/telegram/botToken');
  }
  return {
    chatId: String(config.chatId),
    topicId: config.topicId == null ? null : String(config.topicId),
    tokenFile: config.tokenFile,
    tokenPointer: config.tokenPointer || null,
    coreUrl: config.coreUrl || null,
    alertsUrl: config.alertsUrl || null,
    maxPerRun: Number.isInteger(config.maxPerRun) && config.maxPerRun > 0 ? config.maxPerRun : 5,
    maxAgeHours: Number(config.maxAgeHours) > 0 ? Number(config.maxAgeHours) : 24,
    quietHours: validateQuietHours(config.quietHours),
    stateFile: config.stateFile || DEFAULT_STATE_FILE,
  };
}

/**
 * Optional quiet window, in the owner's time zone: only the listed severities
 * (critical by default) go out inside it. Held alerts and resolution notices
 * stay due and leave at the end of the window.
 */
function validateQuietHours(quiet) {
  if (quiet == null) return null;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(String(quiet.start)) || !hhmm.test(String(quiet.end))) {
    throw new Error('quietHours.start and quietHours.end must be HH:MM');
  }
  const timeZone = quiet.timeZone || 'UTC';
  new Intl.DateTimeFormat('en-US', { timeZone }); // throws on an unknown zone
  return {
    start: quiet.start,
    end: quiet.end,
    timeZone,
    allowSeverities: Array.isArray(quiet.allowSeverities) ? quiet.allowSeverities : ['critical'],
  };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function inQuietHours(now, quiet) {
  if (!quiet) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: quiet.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const minutes = Number(parts.find((p) => p.type === 'hour').value) * 60
    + Number(parts.find((p) => p.type === 'minute').value);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state.relayed === 'object' ? state : { relayed: {} };
  } catch {
    return { relayed: {} };
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readConfig(file) {
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Read the bot token from a raw file, or from a JSON file at a JSON pointer. */
function readToken(tokenFile, tokenPointer, readFile = fs.readFileSync) {
  const raw = readFile(tokenFile, 'utf8');
  let token = raw.trim();
  if (tokenPointer) {
    let node = JSON.parse(raw);
    for (const part of tokenPointer.split('/').slice(1)) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      node = node == null ? undefined : node[key];
    }
    token = typeof node === 'string' ? node.trim() : '';
  }
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error('Telegram bot token is missing or malformed');
  return token;
}

function redact(text, token) {
  const value = String(text || '');
  return token ? value.split(token).join('<token>') : value;
}

/** Active alerts that ask for Telegram and have not been delivered there yet. */
function selectDue(alerts, { now = Date.now(), maxAgeHours = 24, maxPerRun = 5, quietHours = null } = {}) {
  const cutoff = now - maxAgeHours * 60 * 60 * 1000;
  const quiet = inQuietHours(now, quietHours);
  return (alerts || [])
    .filter((alert) => !quiet || quietHours.allowSeverities.includes(alert?.severity))
    .filter((alert) => alert && alert.status === 'active')
    .filter((alert) => Array.isArray(alert.channels) && alert.channels.includes('telegram'))
    .filter((alert) => alert.delivery?.telegram?.sent !== true)
    .filter((alert) => {
      const at = Date.parse(alert.lastNotifiedAt || alert.lastOccurrence || alert.createdAt || '');
      return Number.isFinite(at) && at >= cutoff;
    })
    .slice(0, maxPerRun);
}

function hhmm(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC` : null;
}

function formatMessage(alert, { alertsUrl = null } = {}) {
  const label = SEVERITY_LABELS[alert.severity] || String(alert.severity || 'ALERTE').toUpperCase();
  const reminder = Number(alert.notificationCount) > 1 ? ' · rappel' : '';
  const lines = [`${label}${reminder} · ${alert.title || alert.ruleName || alert.ruleId}`];
  if (alert.message) lines.push(String(alert.message));
  const facts = [`Règle ${alert.ruleId}`];
  const count = Number(alert.occurrenceCount) || 1;
  if (count > 1) facts.push(`${count} occurrences`);
  const since = hhmm(alert.createdAt);
  if (since) facts.push(`depuis ${since}`);
  lines.push(facts.join(' · '));
  if (alertsUrl) lines.push(alertsUrl);
  const text = lines.join('\n');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function durationText(fromValue, toValue) {
  const minutes = Math.round((Date.parse(toValue) - Date.parse(fromValue)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

function formatResolution(alert) {
  const lines = [`✅ Résolu · ${alert.title || alert.ruleName || alert.ruleId}`];
  const resolution = alert.resolution || {};
  const how = resolution.comment || resolution.resolutionMethod;
  if (how) lines.push(String(how));
  const facts = [`Règle ${alert.ruleId}`];
  const lasted = durationText(alert.createdAt, resolution.resolvedAt);
  if (lasted) facts.push(`durée ${lasted}`);
  lines.push(facts.join(' · '));
  const text = lines.join('\n');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

async function requestJson(fetchImpl, method, url, body) {
  const response = await fetchImpl(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`${method} ${url} returned HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function telegramCall(fetchImpl, token, method, params) {
  let payload;
  try {
    payload = await requestJson(fetchImpl, 'POST', `${TELEGRAM_API}/bot${token}/${method}`, params);
  } catch (err) {
    const description = err.payload?.description ? `: ${err.payload.description}` : '';
    throw new Error(redact(`Telegram ${method} failed${description || ` (${err.message})`}`, token));
  }
  if (!payload || payload.ok !== true) {
    throw new Error(redact(`Telegram ${method} rejected: ${payload?.description || 'no ok flag'}`, token));
  }
  return payload.result;
}

async function listActiveAlerts(fetchImpl, coreUrl) {
  const payload = await requestJson(fetchImpl, 'GET', `${coreUrl}/api/alerts?status=active&limit=100`);
  const alerts = payload?.data?.alerts;
  if (!Array.isArray(alerts)) throw new Error('Core alert list is missing data.alerts');
  return alerts;
}

async function recordDelivery(fetchImpl, coreUrl, alertId, outcome) {
  await requestJson(fetchImpl, 'POST', `${coreUrl}/api/alerts/${encodeURIComponent(alertId)}/delivery-status`, {
    channel: 'telegram',
    status: outcome.sent ? 'sent' : 'failed',
    error: outcome.sent ? undefined : String(outcome.error || 'telegram delivery failed').slice(0, 300),
    timestamp: new Date().toISOString(),
  });
}

async function run(options, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const config = deps.config || readConfig(options.config);
  const coreUrl = String(options.coreUrl || config.coreUrl || DEFAULT_CORE_URL).replace(/\/+$/, '');
  const maxPerRun = Number.isInteger(options.maxPerRun) && options.maxPerRun > 0 ? options.maxPerRun : config.maxPerRun;
  const token = options.send || options.createTopic
    ? (deps.token || readToken(config.tokenFile, config.tokenPointer))
    : null;

  if (options.createTopic) {
    const topic = await telegramCall(fetchImpl, token, 'createForumTopic', { chat_id: config.chatId, name: options.createTopic });
    return { mode: 'create-topic', topicId: topic.message_thread_id, name: topic.name };
  }

  const now = deps.now ? deps.now() : Date.now();
  const loadState = deps.readState || readState;
  const saveState = deps.writeState || writeState;
  const state = loadState(config.stateFile);
  let stateChanged = false;
  const quiet = inQuietHours(now, config.quietHours);
  const alerts = await listActiveAlerts(fetchImpl, coreUrl);
  const due = selectDue(alerts, { now, maxAgeHours: config.maxAgeHours, maxPerRun, quietHours: config.quietHours });
  const summary = {
    mode: options.send ? 'send' : 'preview',
    quiet,
    active: alerts.length,
    due: due.length,
    sent: 0,
    failed: 0,
    resolved: 0,
    items: [],
  };

  const post = async (text) => {
    const params = { chat_id: config.chatId, text, disable_web_page_preview: true };
    if (config.topicId) params.message_thread_id = Number(config.topicId);
    await telegramCall(fetchImpl, token, 'sendMessage', params);
  };

  for (const alert of due) {
    const text = formatMessage(alert, { alertsUrl: config.alertsUrl });
    if (!options.send) {
      summary.items.push({ id: String(alert._id), ruleId: alert.ruleId, preview: text });
      continue;
    }
    let outcome;
    try {
      await post(text);
      outcome = { sent: true };
      summary.sent += 1;
      state.relayed[String(alert._id)] = { ruleId: alert.ruleId, sentAt: new Date(now).toISOString() };
      stateChanged = true;
    } catch (err) {
      outcome = { sent: false, error: redact(err.message, token) };
      summary.failed += 1;
    }
    await recordDelivery(fetchImpl, coreUrl, alert._id, outcome);
    summary.items.push({ id: String(alert._id), ruleId: alert.ruleId, sent: outcome.sent, error: outcome.error || null });
  }

  // Resolution notices for alerts this relay posted. Held during quiet hours.
  const budget = Math.max(0, maxPerRun - due.length);
  let notices = 0;
  const justSent = new Set(due.map((alert) => String(alert._id)));
  for (const [id, tracked] of Object.entries(state.relayed)) {
    if (justSent.has(id)) continue;
    if (now - Date.parse(tracked.sentAt) > RESOLUTION_WATCH_MS) {
      delete state.relayed[id];
      stateChanged = true;
      continue;
    }
    if (quiet || notices >= budget) continue;
    let alert;
    try {
      alert = (await requestJson(fetchImpl, 'GET', `${coreUrl}/api/alerts/${encodeURIComponent(id)}`))?.data?.alert;
    } catch (err) {
      if (/HTTP 404/.test(err.message)) {
        delete state.relayed[id];
        stateChanged = true;
      }
      continue;
    }
    if (!alert || alert.status !== 'resolved') continue;
    const text = formatResolution(alert);
    notices += 1;
    if (!options.send) {
      summary.items.push({ id, ruleId: alert.ruleId, preview: text });
      continue;
    }
    try {
      await post(text);
      summary.resolved += 1;
      delete state.relayed[id];
      stateChanged = true;
    } catch (err) {
      summary.failed += 1;
      summary.items.push({ id, ruleId: alert.ruleId, sent: false, error: redact(err.message, token) });
    }
  }

  if (options.send && stateChanged) saveState(config.stateFile, state);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const summary = await run(options);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (summary.mode === 'create-topic') {
    console.log(`Created forum topic "${summary.name}" with id ${summary.topicId}`);
  } else {
    console.log(`Alert Telegram relay (${summary.mode}): ${summary.active} active, ${summary.due} due, ${summary.sent} sent, ${summary.resolved} resolved, ${summary.failed} failed${summary.quiet ? ' (quiet hours)' : ''}`);
    for (const item of summary.items) {
      if (item.preview) console.log(`--- ${item.ruleId} ${item.id}\n${item.preview}`);
      else if (!item.sent) console.log(`FAILED ${item.ruleId} ${item.id}: ${item.error}`);
    }
  }
  return summary.failed > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`Alert Telegram relay failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  formatMessage,
  formatResolution,
  inQuietHours,
  parseArgs,
  readToken,
  redact,
  run,
  selectDue,
  telegramCall,
  validateConfig,
};
