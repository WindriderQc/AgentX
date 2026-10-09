#!/usr/bin/env node
'use strict';

/**
 * Council Telegram mirror.
 *
 * Follows recent Council (roundtable) sessions and posts, in order, a header
 * with the question, each participant's turn under its own name, then the
 * synthesis, to one Telegram forum topic. By default it follows the sessions
 * that seat OpenClaw agents ("all": true follows every session). It is a
 * mirror: the session, interjections and the chair's decision stay on /council.
 *
 * Default mode is a network-free preview for Telegram (Core is still read);
 * `--send` delivers. `--create-topic NAME` creates the forum topic once and
 * prints its id for the config file. The bot token is read from a private file
 * at run time and never printed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readToken, redact, telegramCall } = require('./alert-telegram-relay');

const DEFAULT_CONFIG = process.env.AGENTX_COUNCIL_TELEGRAM_CONFIG
  || path.join(os.homedir(), '.config', 'agentx', 'council-telegram.json');
const DEFAULT_STATE_FILE = path.join(os.homedir(), '.local', 'state', 'agentx', 'council-telegram-relay.json');
const DEFAULT_CORE_URL = 'http://127.0.0.1:3180';
const MAX_TEXT = 3500;
const KEEP_STATE_MS = 7 * 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const options = { config: DEFAULT_CONFIG, send: false, json: false, createTopic: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') options.config = path.resolve(argv[++i]);
    else if (arg === '--send') options.send = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--create-topic') options.createTopic = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Council relay config must be a JSON object');
  if (!/^-?\d+$/.test(String(config.chatId || ''))) throw new Error('chatId must be a Telegram chat id');
  if (config.topicId !== undefined && config.topicId !== null && !/^\d+$/.test(String(config.topicId))) throw new Error('topicId must be a forum topic id');
  if (typeof config.tokenFile !== 'string' || !config.tokenFile) throw new Error('tokenFile is required');
  return {
    chatId: String(config.chatId), topicId: config.topicId ? String(config.topicId) : null,
    tokenFile: config.tokenFile, tokenPointer: config.tokenPointer || null,
    coreUrl: String(config.coreUrl || DEFAULT_CORE_URL).replace(/\/+$/, ''),
    councilUrl: config.councilUrl ? String(config.councilUrl).replace(/\/+$/, '') : null,
    all: config.all === true,
    lookbackHours: Math.max(1, Number(config.lookbackHours) || 24),
    maxPerRun: Math.max(1, Math.min(30, Number(config.maxPerRun) || 12)),
    stateFile: config.stateFile || DEFAULT_STATE_FILE,
    // Display names of the agents that may chair a table, e.g. {"main": "Nestor"}; the agent id otherwise.
    agentNames: config.agentNames && typeof config.agentNames === 'object' && !Array.isArray(config.agentNames) ? config.agentNames : {}
  };
}

const clip = (text) => {
  const value = String(text || '').trim();
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
};

const seatsAgents = (session) => (session.panelConfig || []).some((agent) => agent.runtime === 'openclaw');

/** The messages a session still owes the topic, in order, with the state key each one settles. */
function pendingMessages(session, seen = {}, { councilUrl = null, agentNames = {} } = {}) {
  const out = [];
  if (!seen.header) {
    const link = councilUrl ? `\n${councilUrl}/council?id=${encodeURIComponent(session._id)}` : '';
    out.push({ key: 'header', text: clip(`🧭 Table ronde\n${session.question}${link}`) });
  }
  const done = new Set(seen.turns || []);
  for (const turn of session.turns || []) {
    const key = `${turn.round}:${turn.agentId}`;
    if (done.has(key) || (!String(turn.response || '').trim() && !turn.error)) continue;
    out.push({ key: `turn:${key}`, text: turn.error
      ? clip(`⚠️ ${turn.role || turn.agentId} · tour ${turn.round} : ${turn.error}`)
      : clip(`🗣 ${turn.role || turn.agentId} · tour ${turn.round}\n${turn.response}`) });
  }
  const synthesis = session.synthesis || {};
  if (!seen.synthesis && (String(synthesis.response || '').trim() || synthesis.error)) {
    // When a team member chairs the table, the verdict is signed with its name.
    const chairId = session.synthesizerConfig?.runtime === 'openclaw' ? session.synthesizerConfig.agentId : null;
    const title = chairId ? `Synthèse · ${String(agentNames[chairId] || chairId).slice(0, 60)} (président)` : 'Synthèse';
    out.push({ key: 'synthesis', text: synthesis.error ? clip(`⚠️ ${title} : ${synthesis.error}`) : clip(`🧾 ${title}\n${synthesis.response}`) });
  }
  return out;
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { sessions: {} }; }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function settle(seen, key) {
  if (key === 'header') seen.header = true;
  else if (key === 'synthesis') seen.synthesis = true;
  else seen.turns = [...(seen.turns || []), key.slice('turn:'.length)];
}

async function run(options, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || Date.now;
  const config = validateConfig(deps.config || JSON.parse(fs.readFileSync(options.config, 'utf8')));
  const token = options.send || options.createTopic ? readToken(config.tokenFile, config.tokenPointer, deps.readFile) : null;
  if (options.createTopic) {
    const topic = await telegramCall(fetchImpl, token, 'createForumTopic', { chat_id: config.chatId, name: options.createTopic });
    return { mode: 'create-topic', name: options.createTopic, topicId: topic.message_thread_id };
  }
  const response = await fetchImpl(`${config.coreUrl}/api/roundtable?limit=10`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Core roundtable list returned HTTP ${response.status}`);
  const sessions = ((await response.json())?.data || []).filter((session) =>
    now() - Date.parse(session.createdAt) <= config.lookbackHours * 3600000 && (config.all || seatsAgents(session))).reverse();
  const state = deps.state || readState(config.stateFile);
  state.sessions ||= {};
  const summary = { mode: options.send ? 'send' : 'preview', sessions: sessions.length, sent: 0, failed: 0, items: [] };
  for (const session of sessions) {
    const seen = state.sessions[session._id] ||= { at: new Date(now()).toISOString() };
    for (const message of pendingMessages(session, seen, config)) {
      if (summary.sent + summary.failed >= config.maxPerRun) break;
      if (!options.send) { summary.items.push({ session: session._id, key: message.key, preview: message.text }); continue; }
      try {
        await telegramCall(fetchImpl, token, 'sendMessage', { chat_id: config.chatId, text: message.text,
          ...(config.topicId ? { message_thread_id: Number(config.topicId) } : {}), disable_web_page_preview: true });
        settle(seen, message.key);
        summary.sent += 1;
      } catch (error) {
        summary.failed += 1;
        summary.items.push({ session: session._id, key: message.key, error: redact(error.message, token) });
        break; // keep the order: retry this message first on the next run
      }
    }
  }
  if (options.send) {
    for (const [id, seen] of Object.entries(state.sessions)) if (now() - Date.parse(seen.at) > KEEP_STATE_MS) delete state.sessions[id];
    if (!deps.state) writeState(config.stateFile, state);
  }
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node integrations/operations/council-telegram-relay.js [--config PATH] [--send] [--json] [--create-topic NAME]');
    return 0;
  }
  const summary = await run(options);
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else if (summary.mode === 'create-topic') console.log(`Created forum topic "${summary.name}" with id ${summary.topicId}`);
  else {
    console.log(`Council Telegram mirror (${summary.mode}): ${summary.sessions} session(s), ${summary.sent} sent, ${summary.failed} failed`);
    for (const item of summary.items) console.log(item.preview ? `--- ${item.session} ${item.key}\n${item.preview}` : `FAILED ${item.session} ${item.key}: ${item.error}`);
  }
  return summary.failed > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Council Telegram mirror failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, pendingMessages, run, validateConfig };
