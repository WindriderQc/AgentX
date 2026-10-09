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
        // agentId names the team member whose own default presentation this is.
        layoutConfig: { label: entry.label, voice: entry.voice, visual: entry.visual || null, agentId: entry.agentId || null,
          // styleOf names the member a style belongs to; a personality with neither suits any agent.
          ...(entry.styleOf ? { styleOf: entry.styleOf } : {}),
          kind: 'personality', sourceRef: 'adapters/household/personas.json' }
      }
    };
  });
}

// The instance may give personas another voice (for example a locally cloned
// one) without editing the shared catalog: HOUSEHOLD_PERSONA_VOICES maps a
// persona id, or "*" for every persona, to "provider|voice". A browser's own
// selection still wins. Invalid entries keep the catalog voice.
function instanceVoice(personaId, voice = {}, env = process.env) {
  // A voice chosen for this persona on the Team page outranks the instance-wide map.
  if (voice.source === 'team') return voice;
  let map;
  try { map = JSON.parse(env.HOUSEHOLD_PERSONA_VOICES || '{}'); } catch { return voice; }
  const choice = map?.[personaId] ?? map?.['*'];
  const match = typeof choice === 'string' && /^(kokoro|windows_sapi|voxcpm)\|([^\r\n|]{1,120})$/.exec(choice);
  if (!match) return voice;
  return { ...voice, provider: match[1], voices: { fr: match[2], en: match[2] }, source: 'instance',
    fallback: { provider: voice.provider || 'kokoro', presentation: voice.presentation, voices: voice.voices } };
}

function snapshot(row) {
  const layout = row.uiConfig?.layoutConfig || {};
  return { id: row.name, version: row.version, promptConfigId: String(row._id),
    name: layout.label || row.name, description: row.description || '', identity: row.systemPrompt,
    identitySha256: crypto.createHash('sha256').update(row.systemPrompt).digest('hex'),
    sourceRef: `PromptConfig/${row.name}@${row.version}`,
    voice: instanceVoice(row.name, layout.voice || {}), visual: layout.visual || null, agentId: layout.agentId || null,
    ...(layout.styleOf ? { styleOf: layout.styleOf } : {}), ...(layout.kind ? { kind: layout.kind } : {}) };
}

const { speechFor: presentationSpeechFor } = require('./public/persona-presentation');

// A session freezes identity and catalog presentation, not instance settings.
// Old instance snapshots carry their original catalog voice in fallback; start
// there so removing or invalidating an override restores the catalog default.
function speechFor(persona, language, preferences = {}, env = process.env) {
  if (!persona?.id) return presentationSpeechFor(persona, language, preferences);
  const voice = persona.voice?.source === 'instance' ? persona.voice.fallback || {} : persona.voice || {};
  return presentationSpeechFor({ ...persona, voice: instanceVoice(persona.id, voice, env) }, language, preferences);
}

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

module.exports = { generatedPersonas, snapshot, speechFor, readReplyStream, instanceVoice };
