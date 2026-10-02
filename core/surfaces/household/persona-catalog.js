'use strict';

const crypto = require('node:crypto');
const definitions = require('./personas.json');

function generatedPersonas() {
  return definitions.map((entry) => {
    return {
      name: entry.name,
      description: entry.description,
      systemPrompt: [entry.selfName ? `For this conversation, use the name ${entry.selfName}.` : '', entry.en,
        'Use the language of the conversation. This personality adds presentation to the agent; it does not change its tools, permissions, memory, model or fallback policy.'].filter(Boolean).join('\n\n'),
      uiConfig: { type: 'chat', route: '/index.html', capabilities: ['text'],
        layoutConfig: { label: entry.label, voice: entry.voice, visual: entry.visual || null,
          kind: 'personality', sourceRef: 'adapters/household/personas.json' }
      }
    };
  });
}

function snapshot(row) {
  const layout = row.uiConfig?.layoutConfig || {};
  return { id: row.name, version: row.version, promptConfigId: String(row._id),
    name: layout.label || row.name, description: row.description || '', identity: row.systemPrompt,
    identitySha256: crypto.createHash('sha256').update(row.systemPrompt).digest('hex'),
    sourceRef: `PromptConfig/${row.name}@${row.version}`,
    voice: layout.voice || {}, visual: layout.visual || null };
}

const { speechFor } = require('./public/persona-presentation');

async function readReplyStream(stream, onDelta, signal) {
  const decoder = new TextDecoder();
  let pending = '', answer = '', complete = false;
  const consume = (line) => {
    if (signal?.aborted) return;
    if (!line.trim()) return;
    const row = JSON.parse(line);
    if (row.error) throw new Error(typeof row.error === 'string' ? row.error : row.error.message);
    const delta = row.message?.content || row.response || '';
    if (delta) { answer += delta; onDelta(delta); }
    if (row.done === true) complete = true;
  };
  for await (const chunk of stream) {
    // Keep consuming Core's admitted stream so it can verify EOF and release
    // the host. Cancelled content is neither delivered nor saved as an answer.
    if (signal?.aborted) { pending = ''; continue; }
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      consume(pending.slice(0, newline)); pending = pending.slice(newline + 1);
    }
  }
  if (signal?.aborted) return '';
  pending += decoder.decode();
  if (pending.trim()) consume(pending);
  if (!complete) throw new Error('Reply stream ended before completion');
  return answer;
}

module.exports = { generatedPersonas, snapshot, speechFor, readReplyStream };
