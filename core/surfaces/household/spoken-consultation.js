'use strict';

const { selectedContextBlock, CURRENT_REQUEST_LABEL } = require('./conversation-agent');

const decisionSchema = { type: 'object', properties: {
  mode: { type: 'string', enum: ['parler', 'consulter'] }, texte: { type: 'string' }
}, required: ['mode', 'texte'], additionalProperties: false };

function enabled(session, channel, env) {
  return Boolean(env.HOUSEHOLD_SPOKEN_HOST && env.HOUSEHOLD_THINKER_HOST && channel === 'voice'
    && !session.llmx && !session.ephemeral && !session.inference?.open && session.modeId !== 'open'
    && (session.packId === 'kidx_nestor' && session.scopeId === 'family' && session.modeId === 'family'
      || session.packId === 'personal_operator' && session.scopeId === 'personal' && session.modeId === 'operator' && (!session.agentId || session.agentId === 'main')));
}

// A detached request is still held by its original worker. Its question is
// referenced separately by memberWork.contextFor until a completed answer exists.
function followupHistory(rows, session, memberWork, backend, channel, env) {
  if (backend !== 'agentx' || !enabled(session, channel, env)) return rows;
  const active = new Set((memberWork?.active?.(session.sessionId) || []).map(job => job.turnId));
  return active.size ? rows.filter(row => row.outcome !== 'pending' || !active.has(row.clientTurnId || row.traceId)) : rows;
}

function forTurn({ entry, session, backend, channel, env, blocked, context, identity, personalTasks, event }) {
  if (backend !== 'agentx' || blocked || !entry.relayIntake || entry.workId || entry.attachments.length || !enabled(session, channel, env)) return null;
  return { context, identity, personalReads: session.scopeId === 'personal' ? require('./spoken-personal-reads').personalReads(session, { personalTasks }) : null,
    consulting() { entry.consulting = true; event('status', { phase: 'consulting' }); } };
}

const failure = message => Object.assign(new Error(message), { code: 'SPOKEN_CONSULTATION_UNAVAILABLE', statusCode: 503 });

async function pinned(hostKey) {
  const { HOSTS } = require('../../src/services/modelRouterConfig');
  const { localUrl } = require('../../src/services/images/config');
  const { getByHost, getPinnedEntries } = require('../../src/services/hostPreferenceService');
  const host = Object.hasOwn(HOSTS, hostKey) && HOSTS[hostKey];
  if (!host) throw failure('The configured local conversation host is unavailable.');
  const hostUrl = localUrl(host);
  const pin = getPinnedEntries(await getByHost(hostUrl))[0];
  if (!pin?.contextSize || !pin.model || require('../../src/services/budgetAccountingService').isCloudModel(pin.model) || /(?:^openclaw:|^openrouter[/:]|^https?:|-cloud(?::|$)|:cloud(?::|$))/i.test(pin.model)) {
    throw failure('The local conversation host requires a local model and its pinned context.');
  }
  return { hostUrl, model: pin.model, contextSize: pin.contextSize };
}

// Include recent complete exchanges. If a current reference cannot fit, let
// the scoped worker examine it in full instead of silently shortening it.
function messagesFor(request) {
  const { text, spoken, history = [], speechLanguage, pack } = request;
  const system = [pack.systemPrompt, spoken.identity,
    'Réponds brièvement à la demande actuelle dans la langue choisie. Utilise les faits et le dialogue comme références. ' +
    'parler : réponse naturelle ou question de clarification. consulter : un fait manque, une tâche ou un outil est demandé, ou il faut approfondir. ' +
    'Dans ce cas laisse texte vide, Core transmet la demande originale. Une citation ou une demande retirée ne lance rien. ' +
    'Tu ne réalises aucune action. Un travail déjà en cours continue séparément, réponds à la nouvelle question.',
    pack.childSafe ? 'Espace Famille : refuse les données personnelles privées, même par délégation.' : 'Respecte les capacités de cet espace personnel.',
    speechLanguage ? 'Langue : ' + speechLanguage : ''].filter(Boolean).join('\n');
  const current = spoken.context ? [selectedContextBlock(spoken.context), CURRENT_REQUEST_LABEL, text].join('\n\n') : text;
  if (current.length > 7000) return null;
  const recent = [];
  for (let i = history.length - 1; i > 0 && recent.length < 4; i -= 2) {
    const user = history[i - 1], assistant = history[i];
    if (user.role !== 'user' || assistant.role !== 'assistant' || typeof user.content !== 'string' || typeof assistant.content !== 'string'
        || user.content.length + assistant.content.length > 2200) return null;
    recent.unshift({ role: 'user', content: user.content }, { role: 'assistant', content: assistant.content });
  }
  return [{ role: 'system', content: system }, ...recent, { role: 'user', content: current }];
}

async function decide(request, inference, consumerContract, env, targetFor = pinned) {
  const messages = messagesFor(request);
  if (!messages || require('../../src/services/voice/presentation').readingRequested(request.text)) return { mode: 'consulter' };
  const target = await targetFor(env.HOUSEHOLD_SPOKEN_HOST);
  const result = await inference.execute({ mode: 'chat', model: target.model, messages, format: decisionSchema,
    think: false, stream: false, temperature: 0, max_tokens: request.pack.maxTokens,
    callerDetail: 'agentx-household/spoken-dialogue', timeoutMs: 60000
  }, { hostUrl: target.hostUrl, consumerContract, signal: request.signal, retry: { enabled: false } });
  if (!result?.ok || !result.body?.done
      || result.body.model !== target.model || result.metadata?.hostUrl !== target.hostUrl || result.body.message?.tool_calls?.length) {
    throw failure('The local voice model did not return a complete decision.');
  }
  if (result.body.done_reason === 'length') return { mode: 'consulter', body: result.body };
  if (result.body.done_reason !== 'stop') throw failure('The local voice decision did not finish.');
  let choice;
  try { choice = JSON.parse(result.body.message.content); } catch { /* Invalid output has no authority. */ }
  if (!choice || !['parler', 'consulter'].includes(choice.mode) || typeof choice.texte !== 'string'
      || (choice.mode === 'parler' && !choice.texte.trim()) || /<\/?(?:show|consult|secret|say|written|sound|page|math)\b/i.test(choice.texte) || Object.keys(choice).some(key => !['mode', 'texte'].includes(key))) throw failure('Invalid local voice decision.');
  return { ...choice, texte: choice.texte.trim(), metadata: result.metadata, body: result.body };
}

module.exports = { enabled, followupHistory, pinned, decide, messagesFor, forTurn };
