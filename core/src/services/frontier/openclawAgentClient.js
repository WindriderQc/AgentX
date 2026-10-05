'use strict';

// Frontier inference through an OpenClaw agent. Core stays the owner of the
// conversation and its memory: every call carries the full instructions and
// history, under a fresh session key, and OpenClaw is only the transport to a
// cloud model whose credential it holds. A surface chooses this lane
// explicitly; no Core fallback ever selects it.

const crypto = require('crypto');

const AGENT_ID = /^[a-z0-9_-]{1,64}$/;
const MAX_INSTRUCTIONS = 60000;
const MAX_REPLY = 60000;
// The gateway opens the stream at once and may deliver the text only at the end,
// so silence is judged on the first frame, and the whole turn has its own cap.
const FIRST_FRAME_MS = 30000;
const MAX_TURN_MS = 180000;

function frontierError(message, code, status = 502) {
  return Object.assign(new Error(message), { code, statusCode: status });
}

function parseEvents(buffer) {
  const events = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  let boundary;
  while ((boundary = rest.indexOf('\n\n')) >= 0) {
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const named = (block.match(/^event:\s*(.*)$/m) || [])[1];
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data) continue;
    // A frame without an event line still names itself in its data.
    try { const parsed = JSON.parse(data); const event = named || parsed.type; if (event) events.push({ event, data: parsed }); }
    catch { /* an unreadable frame carries nothing usable */ }
  }
  return { events, rest };
}

function finalText(response) {
  if (response?.status !== 'completed') return '';
  return (response.output || []).filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('').trim();
}

function createOpenClawAgentClient({ env = process.env, fetchImpl = fetch } = {}) {
  const base = String(env.OPENCLAW_GATEWAY_URL || '').replace(/^ws/, 'http').replace(/\/$/, '');
  const token = env.OPENCLAW_GATEWAY_TOKEN || '';
  const available = agentId => Boolean(base && token && AGENT_ID.test(String(agentId || '')));

  // run({ agentId, instructions, messages, signal, timeoutMs, onToken }) -> { content, usage }
  // maxTurnMs raises the cap for background work that reads and writes a lot.
  async function run({ agentId, instructions, messages, signal, timeoutMs = MAX_TURN_MS, maxTurnMs = MAX_TURN_MS, firstFrameMs = FIRST_FRAME_MS, onToken }) {
    if (!available(agentId)) throw frontierError('The frontier agent is not configured.', 'FRONTIER_NOT_CONFIGURED', 503);
    const silence = new AbortController();
    let silenceTimer = setTimeout(() => silence.abort(), firstFrameMs);
    const heard = () => { clearTimeout(silenceTimer); silenceTimer = null; };
    const timeout = AbortSignal.timeout(Math.min(timeoutMs, maxTurnMs));
    const abort = AbortSignal.any([silence.signal, timeout, ...(signal ? [signal] : [])]);
    try {
      return await exchange({ agentId, instructions, messages, abort, heard, onToken });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (silence.signal.aborted) throw frontierError('The frontier agent did not answer in time.', 'FRONTIER_SILENT', 504);
      if (timeout.aborted) throw frontierError('The frontier agent took too long.', 'FRONTIER_TIMEOUT', 504);
      throw error.code && typeof error.code === 'string' ? error : frontierError(error.message || 'The frontier agent is unreachable.', 'FRONTIER_UNREACHABLE');
    } finally {
      heard();
    }
  }

  async function exchange({ agentId, instructions, messages, abort, heard, onToken }) {
    const response = await fetchImpl(`${base}/v1/responses`, {
      method: 'POST',
      // The turn body must never follow a redirect to another destination.
      redirect: 'error',
      signal: abort,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // A fresh key per call: the agent keeps no conversation of its own.
        'x-openclaw-session-key': `agent:${agentId}:turn-${crypto.randomUUID()}`
      },
      body: JSON.stringify({
        model: `openclaw/${agentId}`,
        stream: true,
        instructions: String(instructions || '').slice(0, MAX_INSTRUCTIONS),
        input: messages.map(message => ({ type: 'message', role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '') }))
      })
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw frontierError(`The frontier agent answered ${response.status}.`, 'FRONTIER_UNAVAILABLE');
    }

    let content = '', completed = null, buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      const parsed = parseEvents(buffer + decoder.decode(chunk, { stream: true }));
      buffer = parsed.rest;
      for (const { event, data } of parsed.events) {
        heard();
        if (event === 'response.output_text.delta' && data.delta) {
          content += data.delta;
          onToken?.(data.delta);
        } else if (event === 'response.completed') completed = data.response || data;
        else if (event === 'response.incomplete') throw frontierError('The frontier agent stopped before finishing.', 'FRONTIER_INCOMPLETE');
        else if (event === 'response.failed' || event === 'error') {
          throw frontierError(data.response?.error?.message || data.message || 'The frontier agent failed.', 'FRONTIER_FAILED');
        }
      }
    }
    // A stream that ends without its completion frame was cut: it is not a finished reply.
    if (!completed) throw frontierError('The frontier agent stream ended before completion.', 'FRONTIER_INCOMPLETE');
    const text = (content.trim() || finalText(completed)).slice(0, MAX_REPLY);
    if (!text) throw frontierError('The frontier agent returned no text.', 'FRONTIER_EMPTY');
    return { content: text, usage: completed?.usage || null, streamed: Boolean(content.trim()) };
  }

  return { available, run };
}

module.exports = { createOpenClawAgentClient, parseEvents, finalText };
