/**
 * Runtime participants for Roundtable v2: the optional Codex bridge, and named
 * OpenClaw agents (Nestor, the Secretary, the accountant...) seated at the table
 * through the gateway, each in a session dedicated to that Council session.
 *
 * Model participants remain native to AgentX.
 */

const fetch = require('node-fetch');

const RUNTIME_TYPES = new Set(['codex', 'openclaw']);
const OPENCLAW_AGENT = /^[a-z0-9_-]{1,64}$/;
const MAX_PROMPT_CHARS = 30000;
const MAX_RESPONSE_CHARS = 20000;

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function buildRuntimePrompt(messages, agent) {
  const transcript = (messages || []).map((message) => {
    const role = String(message.role || 'user').toUpperCase();
    return `[${role}]\n${String(message.content || '')}`;
  }).join('\n\n');
  const guard = [
    'You are participating in an AgentX Roundtable deliberation.',
    `Speak as ${agent.role || agent.agentId}.`,
    'This turn is advisory only: do not execute commands, modify files, send messages, or change external state.',
    'Return only your concise position, evidence, disagreements, and recommended next step.',
    'Do not reveal hidden chain-of-thought or private credentials.'
  ].join(' ');
  const transcriptBudget = Math.max(0, MAX_PROMPT_CHARS - guard.length - 2);
  return `${guard}\n\n${transcript.slice(-transcriptBudget)}`;
}

function configuredBridgeUrl(env) {
  const raw = env.ROUNDTABLE_CODEX_BRIDGE_URL;
  if (!raw) throw new Error('ROUNDTABLE_CODEX_BRIDGE_URL is not configured');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Codex bridge URL must use http or https');
  }
  return url.toString();
}

function validateRuntimeConfiguration(panel, env = process.env) {
  try {
    const runtimes = new Set((panel || []).map((agent) => String(agent.runtime || 'model').toLowerCase()));
    runtimes.delete('model');
    if (!runtimes.size) return true;
    const unsupported = [...runtimes].filter((runtime) => !RUNTIME_TYPES.has(runtime));
    if (unsupported.length) throw new Error(`Unsupported runtime participant: ${unsupported.join(', ')}`);
    if (!enabled(env.ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED)) {
      throw new Error('Runtime participants are disabled; set ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED=true');
    }
    if (runtimes.has('codex')) configuredBridgeUrl(env);
    if (runtimes.has('openclaw')) {
      gatewayUrl(env);
      const invalid = (panel || []).filter((agent) => String(agent.runtime || '').toLowerCase() === 'openclaw'
        && !OPENCLAW_AGENT.test(String(agent.agentId || '')));
      if (invalid.length) throw Object.assign(new Error('An OpenClaw participant must use its OpenClaw agent id'), { status: 400 });
    }
    return true;
  } catch (err) {
    err.status = err.status || 503;
    throw err;
  }
}

async function callCodex(agent, prompt, context, deps) {
  const url = configuredBridgeUrl(deps.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (deps.env.ROUNDTABLE_CODEX_BRIDGE_TOKEN) {
      headers.Authorization = `Bearer ${deps.env.ROUNDTABLE_CODEX_BRIDGE_TOKEN}`;
    }
    const response = await deps.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: prompt,
        sessionKey: agent.runtimeConfig?.sessionKey || `roundtable-${context.roundtableId}`,
        metadata: { roundtableId: context.roundtableId, round: context.round, agentId: agent.agentId }
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || `Codex bridge returned ${response.status}`);
    const text = body.response || body.text || body.result?.response || body.result?.text;
    if (!String(text || '').trim()) throw new Error('Codex bridge returned no final response text');
    return {
      response: String(text).trim().slice(0, MAX_RESPONSE_CHARS),
      target: 'codex://bridge',
      hostName: new URL(url).host,
      runtimeRef: body.sessionId || body.sessionKey || null
    };
  } finally {
    clearTimeout(timer);
  }
}

function gatewayUrl(env) {
  if (!env.OPENCLAW_GATEWAY_URL || !env.OPENCLAW_GATEWAY_TOKEN) {
    throw new Error('OpenClaw participants need OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN');
  }
  const url = new URL(String(env.OPENCLAW_GATEWAY_URL).replace(/^ws/, 'http'));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OpenClaw gateway URL must use http or https');
  return url;
}

// The agent's last assistant message of a completed, non-streamed native run.
function finalOpenClawText(body) {
  if (body?.status !== 'completed') throw new Error(`OpenClaw run ended ${body?.status || 'without a status'}`);
  const messages = (Array.isArray(body.output) ? body.output : []).filter((item) => item?.type === 'message' && item.role === 'assistant');
  const last = messages.at(-1);
  return (Array.isArray(last?.content) ? last.content : []).filter((part) => part?.type === 'output_text')
    .map((part) => String(part.text || '')).join('').trim();
}

// Every seated agent thinks with its own brain. A conversation provider answers
// with a lighter model when the host is busy, which would handicap one speaker
// against another; ROUNDTABLE_OPENCLAW_STRICT_PROVIDERS (for example
// {"agentx-conversation":"ollama"}) names, per provider, the strict one that
// waits for the host instead. The model itself is never changed.
function strictModel(model, env) {
  let map;
  try { map = JSON.parse(env.ROUNDTABLE_OPENCLAW_STRICT_PROVIDERS || '{}'); } catch { return null; }
  const text = String(model || ''), slash = text.indexOf('/');
  const strict = slash > 0 ? map?.[text.slice(0, slash)] : null;
  return typeof strict === 'string' && /^[a-z0-9_-]{1,40}$/.test(strict) ? strict + text.slice(slash) : null;
}

const catalogCache = { at: 0, key: '', models: new Map() };
async function agentModel(agentId, deps) {
  if (!deps.env.ROUNDTABLE_OPENCLAW_STRICT_PROVIDERS) return null;
  const key = String(deps.env.OPENCLAW_GATEWAY_URL), now = Date.now();
  if (catalogCache.key !== key || now - catalogCache.at > 5 * 60 * 1000) {
    const agents = await listOpenClawAgents(deps.env, deps.fetchImpl);
    if (agents.length) Object.assign(catalogCache, { at: now, key, models: new Map(agents.map((agent) => [agent.id, agent.model])) });
  }
  return catalogCache.models.get(agentId) || null;
}

async function callOpenClaw(agent, prompt, context, deps) {
  const agentId = String(agent.agentId || '');
  if (!OPENCLAW_AGENT.test(agentId)) throw new Error('An OpenClaw participant must use its OpenClaw agent id');
  const base = gatewayUrl(deps.env);
  const strict = strictModel(await agentModel(agentId, deps), deps.env);
  // One native session per Council session and agent: the debate never enters the agent's own conversations.
  const sessionKey = `agent:${agentId}:roundtable:${String(context.roundtableId || 'adhoc').replace(/[^A-Za-z0-9-]/g, '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    const response = await deps.fetchImpl(new URL('/v1/responses', base).toString(), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.env.OPENCLAW_GATEWAY_TOKEN}`,
        'x-openclaw-session-key': sessionKey, 'x-openclaw-message-channel': 'webchat',
        ...(strict ? { 'x-openclaw-model': strict } : {}) },
      body: JSON.stringify({ model: `openclaw/${agentId}`, stream: false,
        instructions: 'AgentX Roundtable turn: advisory only. Use read-only tools if they help; never send, write, modify or execute anything.',
        input: [{ type: 'message', role: 'user', content: prompt }] })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || body?.message || `OpenClaw returned ${response.status}`);
    const text = finalOpenClawText(body);
    if (!text) throw new Error('OpenClaw returned no final response text');
    return { response: text.slice(0, MAX_RESPONSE_CHARS), target: `openclaw://${agentId}`, hostName: base.host, runtimeRef: sessionKey };
  } finally {
    clearTimeout(timer);
  }
}

// The agents a Council may seat, from the OpenClaw gateway's own catalog.
async function listOpenClawAgents(env = process.env, fetchImpl = fetch) {
  if (!enabled(env.ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED)) return [];
  try {
    const response = await fetchImpl(new URL('/api/nestor/continuity', gatewayUrl(env)).toString(), {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}` },
      body: JSON.stringify({ operation: 'agents' })
    });
    const body = await response.json();
    if (!response.ok || body?.authority !== 'openclaw.nestor' || !Array.isArray(body.agents)) return [];
    return body.agents.filter((agent) => OPENCLAW_AGENT.test(String(agent?.id || '')) && agent.id !== 'family')
      .map((agent) => ({ id: agent.id, name: String(agent.name || agent.id).slice(0, 80), model: String(agent.model || '').slice(0, 160) }));
  } catch {
    return [];
  }
}

async function callRuntimeParticipant(agent, messages, context = {}, options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env;
  const runtime = String(agent.runtime || 'model').toLowerCase();
  const timeoutMs = Math.max(1000, Number(context.timeoutMs) || 120000);
  try {
    if (!RUNTIME_TYPES.has(runtime)) throw new Error(`Unsupported runtime participant: ${runtime}`);
    if (!enabled(env.ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED)) {
      throw new Error('Runtime participants are disabled; set ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED=true');
    }
    const call = runtime === 'openclaw' ? callOpenClaw : callCodex;
    const result = await call(agent, buildRuntimePrompt(messages, agent), { ...context, timeoutMs }, {
      env,
      fetchImpl: options.fetchImpl || fetch,
    });
    const completedAt = new Date();
    return {
      response: result.response,
      thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: null,
      target: result.target,
      hostName: result.hostName,
      runtime,
      runtimeRef: result.runtimeRef,
      startedAt,
      completedAt
    };
  } catch (err) {
    const completedAt = new Date();
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: err.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : err.message,
      target: `${runtime}://unavailable`, hostName: null, runtime, runtimeRef: null,
      startedAt, completedAt
    };
  }
}

module.exports = {
  RUNTIME_TYPES,
  buildRuntimePrompt,
  callRuntimeParticipant,
  finalOpenClawText,
  listOpenClawAgents,
  strictModel,
  validateRuntimeConfiguration
};
