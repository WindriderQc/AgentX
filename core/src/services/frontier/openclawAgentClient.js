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
    const event = (block.match(/^event: (.*)$/m) || [])[1];
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (event && data) { try { events.push({ event, data: JSON.parse(data) }); } catch { /* an unreadable frame carries nothing usable */ } }
  }
  return { events, rest };
}

function finalText(response) {
  if (response?.status !== 'completed') return '';
  return (response.output || []).filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('').trim();
}

function createOpenClawAgentClient({ env = process.env, fetchImpl = fetch } = {}) {
  const base = String(env.OPENCLAW_GATEWAY_URL || '').replace(/\/$/, '');
  const token = env.OPENCLAW_GATEWAY_TOKEN || '';
  const available = agentId => Boolean(base && token && AGENT_ID.test(String(agentId || '')));

  // run({ agentId, instructions, messages, signal, timeoutMs, onToken }) -> { content, usage }
  async function run({ agentId, instructions, messages, signal, timeoutMs = 300000, onToken }) {
    if (!available(agentId)) throw frontierError('The frontier agent is not configured.', 'FRONTIER_NOT_CONFIGURED', 503);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${base}/v1/responses`, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
    if (!response.ok || !response.body) throw frontierError(`The frontier agent answered ${response.status}.`, 'FRONTIER_UNAVAILABLE');

    let content = '', completed = null, buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      const parsed = parseEvents(buffer + decoder.decode(chunk, { stream: true }));
      buffer = parsed.rest;
      for (const { event, data } of parsed.events) {
        if (event === 'response.output_text.delta' && data.delta) {
          content += data.delta;
          onToken?.(data.delta);
        } else if (event === 'response.completed') completed = data.response || data;
        else if (event === 'response.failed' || event === 'error') {
          throw frontierError(data.response?.error?.message || data.message || 'The frontier agent failed.', 'FRONTIER_FAILED');
        }
      }
    }
    const text = (content.trim() || finalText(completed)).slice(0, MAX_REPLY);
    if (!text) throw frontierError('The frontier agent returned no text.', 'FRONTIER_EMPTY');
    return { content: text, usage: completed?.usage || null, streamed: Boolean(content.trim()) };
  }

  return { available, run };
}

module.exports = { createOpenClawAgentClient, parseEvents, finalText };
