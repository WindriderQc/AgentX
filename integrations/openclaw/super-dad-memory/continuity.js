import { readState } from "./store.js";
import { nativeToolChecks } from './tool-evidence.js';

const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const householdKey = /^agent:([a-z0-9][a-z0-9_-]*):household:direct:[a-f0-9-]{36}$/;

export function configuredAgents(config = {}) {
  return config.agents?.entries || Object.fromEntries((config.agents?.list || []).map(agent => [agent.id, agent]));
}

export function householdWorkspace(context, config, resolveWorkspace) {
  const match = householdKey.exec(context.sessionKey || '');
  if (!match || context.agentId !== match[1] || !configuredAgents(config)[match[1]]) return null;
  return resolveWorkspace ? resolveWorkspace(match[1]) : configuredAgents(config)[match[1]].workspace || null;
}

// Display only: the native model object stays in OpenClaw. No model is selected
// from this projection and no credential, path, prompt or tool allowlist leaves it.
export function agentCatalog(config = {}, modelFor = () => null) {
  return Object.entries(configuredAgents(config)).map(([id, agent]) => ({
    id, name: agent.identity?.name || agent.name || id,
    model: modelFor(id) || null,
    toolsProfile: agent.tools?.profile || config.tools?.profile || null,
    personalNotes: id === 'main'
  }));
}
// Native evidence is projected without copying the transcript or owning notes.
const finalText = message => {
  if (message?.stopReason !== 'stop' || message.phase === 'commentary' || !Array.isArray(message.content)
      || message.content.some(part => part.type === 'toolCall')) return '';
  return message.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n').trim();
};
const yielded = message => message?.stopReason === 'toolUse' && Array.isArray(message.content)
  && message.content.some(part => part.type === 'toolCall' && part.name === 'sessions_yield');
// These tools finish in a background task: the run ends on the call, and the
// task's completion run (`<tool>:<taskId>:...`) answers this session afterwards.
const BACKGROUND_TOOLS = new Set(['image_generate']);
const backgroundTool = message => message?.stopReason === 'toolUse' && Array.isArray(message.content)
  && message.content.filter(part => part?.type === 'toolCall')
    .map(part => part.name === 'tool_call' ? String(part.arguments?.id || '').split(':').at(-1) : part.name)
    .find(name => BACKGROUND_TOOLS.has(name));

export function nativeTurnAnswer(history, sessionKey, runId) {
  const unavailable = { status: 'unavailable', source: 'openclaw/sessions.get', runId };
  if (history?.sessionKey !== sessionKey || !Array.isArray(history.messages)) return unavailable;
  const messages = history.messages;
  const last = messages.findLastIndex(row => row?.role === 'assistant' && row.__openclaw?.runId === runId);
  const message = messages[last];
  // A run that delegated to a sub-agent ends on sessions_yield. Its answer
  // arrives in the native announce run that settles this session afterwards.
  if (yielded(message)) {
    const settle = `announce:requester-settle:${sessionKey.split(':')[1]}:${sessionKey}:`;
    const reply = messages.slice(last + 1).filter(row => row?.role === 'assistant' && row.__openclaw?.runId?.startsWith(settle)).at(-1);
    const text = finalText(reply);
    return text ? { status: 'ready', source: 'openclaw/sessions.get', runId, deliveredBy: reply.__openclaw.runId, messageId: reply.__openclaw.id, text }
      : { status: 'yielded', source: 'openclaw/sessions.get', runId };
  }
  const background = backgroundTool(message);
  if (background) {
    // Only completions before the next Household turn belong to this one.
    const later = messages.slice(last + 1);
    const next = later.findIndex(row => row?.role === 'assistant' && /^resp_/.test(row.__openclaw?.runId || ''));
    const reply = (next < 0 ? later : later.slice(0, next)).filter(row => row?.role === 'assistant'
      && row.__openclaw?.runId?.startsWith(`${background}:`) && finalText(row)).at(-1);
    return reply ? { status: 'ready', source: 'openclaw/sessions.get', runId, deliveredBy: reply.__openclaw.runId,
      messageId: reply.__openclaw.id, text: finalText(reply) } : { status: 'yielded', source: 'openclaw/sessions.get', runId };
  }
  const text = finalText(message);
  return text ? { status: 'ready', source: 'openclaw/sessions.get', runId, messageId: message.__openclaw.id, text } : unavailable;
}

// What the run is doing, for a spoken progress line: tool names and a target
// agent id only. Arguments, results and commentary never leave OpenClaw.
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : null;
export function nativeTurnProgress(history, sessionKey, runId) {
  if (history?.sessionKey !== sessionKey || !Array.isArray(history.messages)) return [];
  return history.messages.filter(row => row?.role === 'assistant' && row.__openclaw?.runId === runId && Array.isArray(row.content))
    .flatMap(row => row.content.map((part, index) => ({ part, id: safeName(part?.id) || `${row.__openclaw.id}:${index}` })))
    .filter(({ part }) => part?.type === 'toolCall' && safeName(part.name))
    .map(({ part, id }) => {
      // Deferred tools run through tool_call with the native tool id inside.
      const wrapped = part.name === 'tool_call' && safeName(part.arguments?.id);
      const args = (wrapped ? part.arguments.args : part.arguments) || {};
      const agentId = typeof args.agentId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(args.agentId) ? args.agentId : undefined;
      return { id, tool: wrapped ? wrapped.split(':').at(-1) : part.name, ...(agentId ? { agentId } : {}) };
    });
}

export function continuityOperations({ workspace, config, resolveWorkspace, modelFor, readHistory }) {
  return async request => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw invalid("Expected an object");
    const operation = request.operation;
    let result;
    if (operation === 'agents') {
      if (!config) throw new Error('Native agent configuration unavailable');
      result = { agents: agentCatalog(config, modelFor) };
    } else if (operation === "turn") {
      const match = householdKey.exec(request.sessionKey || '');
      if (!/^resp_[a-f0-9-]{36}$/.test(request.runId || "") || !match) {
        throw invalid("A Household agent turn is required");
      }
      const agentWorkspace = config ? householdWorkspace({ agentId: match[1], sessionKey: request.sessionKey }, config, resolveWorkspace)
        : match[1] === 'main' ? workspace : null;
      if (!agentWorkspace) throw invalid('The native agent is unavailable');
      const state = await readState(agentWorkspace);
      const matches = row => row.runId === request.runId && row.sessionKey === request.sessionKey;
      result = { run: (state.runs || []).find(matches) || null, receipts: state.receipts.filter(matches) };
      // Read the existing native transcript, never copy another conversation
      // into the receipt capsule. Responses SSE merges tool preambles and final
      // text, so only a completed native assistant message is safe to deliver.
      let history;
      try { history = await readHistory?.(request.sessionKey); } catch { /* unavailable, not aggregate SSE text */ }
      result.answer = nativeTurnAnswer(history, request.sessionKey, request.runId);
      result.progress = nativeTurnProgress(history, request.sessionKey, request.runId);
      result.toolChecks = nativeToolChecks(history, request.sessionKey, request.runId);
    } else throw invalid("Choose agents or turn; notes belong to AgentX Core");
    return { ok: true, authority: "openclaw.nestor", operation, ...result };
  };
}

export function continuityHttpHandler(operate, unavailableMessage = "Nestor personal notes are unavailable") {
  return async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); return true; };
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(405, { ok: false, message: "Use POST" }); }
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16384) return send(413, { ok: false, message: "Request is too large" });
        chunks.push(Buffer.from(chunk));
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw invalid("Invalid JSON"); }
      return send(200, await operate(body));
    } catch (error) {
      return send(error.statusCode === 400 ? 400 : 503, { ok: false,
        message: error.statusCode === 400 ? error.message : unavailableMessage });
    }
  };
}
