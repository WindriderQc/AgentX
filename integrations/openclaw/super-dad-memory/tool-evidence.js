import { createHash } from 'node:crypto';
import { isNativeToolCallId } from '../../../shared/nativeToolCallId.cjs';

// Compare inside the native adapter. Neither arguments, results nor their
// fingerprints leave it; Core receives only completed tool names and a loop.
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : null;
const WAIT_TOOLS = new Set(['process', 'sessions_yield', 'sessions_history']);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');

function successful(result, tool) {
  if (result.isError === true || result.error || result.status === 'error') return false;
  const payloads = [];
  for (const part of result.content || []) {
    if (part.type !== 'text') continue;
    try {
      const data = JSON.parse(part.text);
      if (data?.ok === false || data?.status === 'error' || data?.isError === true || data?.error) return false;
      payloads.push(data?.data || data);
    } catch { /* plain text is an observed result too */ }
  }
  if (['list_personal_tasks', 'agentx__list_personal_tasks'].includes(tool)) return payloads.some(data => Array.isArray(data?.tasks));
  if (['personal_briefing', 'agentx__personal_briefing'].includes(tool)) return payloads.some(data => Number.isInteger(data?.counts?.open) && data.counts.open >= 0);
  return result.content.length > 0;
}

// OpenClaw's requester-settle identity names the accepted child run(s), followed
// by optional yield/retry counters. Attribute only a single, identified child.
function settledChild(calls, results, sessionKey, deliveredBy) {
  const prefix = `announce:requester-settle:${sessionKey.split(':')[1]}:${sessionKey}:`;
  if (typeof deliveredBy !== 'string' || !deliveredBy.startsWith(prefix)) return null;
  const match = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?::yield-\d+)?(?::retry-\d+)?$/.exec(deliveredBy.slice(prefix.length));
  if (!match) return null;
  for (const call of calls) {
    if (call.identity !== 'sessions_spawn' && !(call.wrapped && call.identity === 'openclaw:core:sessions_spawn')) continue;
    const result = results.get(call.id);
    if (!Array.isArray(result?.content) || !successful(result, call.tool)) continue;
    const native = call.wrapped ? result.details?.result : result;
    if (call.wrapped && (result.details?.tool?.id !== 'openclaw:core:sessions_spawn' || native?.isError)) continue;
    const accepted = native?.details;
    if (accepted?.status !== 'accepted' || accepted.runId !== match[1]) continue;
    const agent = /^agent:([a-z0-9][a-z0-9_-]{0,63}):subagent:[a-f0-9-]+$/.exec(accepted.childSessionKey || '');
    if (agent && (!call.args?.agentId || call.args.agentId === agent[1])) {
      return { agentId: agent[1], runId: accepted.runId };
    }
  }
  return null;
}

export function nativeToolChecks(history, sessionKey, runId, deliveredBy) {
  const unavailable = { status: 'unavailable', runId, completedTools: [], loop: null };
  if (history?.sessionKey !== sessionKey || !Array.isArray(history.messages)) return unavailable;
  const calls = [], results = new Map(), seen = new Set();
  let inside = false;
  for (const row of history.messages) {
    if (row?.role === 'assistant') {
      inside = row.__openclaw?.runId === runId;
      if (!inside || !Array.isArray(row.content)) continue;
      for (const part of row.content) {
        if (part?.type !== 'toolCall' || !safeName(part.name) || !isNativeToolCallId(part.id)) continue;
        if (seen.has(part.id)) continue;
        seen.add(part.id);
        const wrapped = part.name === 'tool_call' && safeName(part.arguments?.id);
        calls.push({ id: part.id, tool: wrapped ? wrapped.split(':').at(-1) : part.name,
          identity: wrapped || part.name, wrapped: Boolean(wrapped), args: wrapped ? part.arguments.args : part.arguments });
      }
    } else if (inside && row?.role === 'toolResult' && isNativeToolCallId(row.toolCallId)) {
      if (!row.__openclaw?.runId || row.__openclaw.runId === runId) results.set(row.toolCallId, row);
    } else if (row?.role === 'user') inside = false;
  }
  const completedTools = new Set();
  let previous, repeats = 0, loop = null;
  for (const call of calls) {
    const result = results.get(call.id);
    if (!result || !Array.isArray(result.content)) { previous = null; repeats = 0; continue; }
    if (successful(result, call.tool)) completedTools.add(call.tool);
    const key = fingerprint([call.identity, call.args ?? {}, result.content, result.isError === true]);
    repeats = key === previous ? repeats + 1 : 1;
    previous = key;
    if (!WAIT_TOOLS.has(call.tool) && repeats >= 4 && !loop) loop = { tool: call.tool, repetitions: repeats };
  }
  return { status: 'observed', runId, completedTools: [...completedTools], loop,
    ...(deliveredBy?.startsWith('announce:requester-settle:') && { settledChild: settledChild(calls, results, sessionKey, deliveredBy) }) };
}
