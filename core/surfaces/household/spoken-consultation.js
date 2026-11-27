'use strict';

const { selectedContextBlock, CURRENT_REQUEST_LABEL } = require('./conversation-agent');

const { readReplyFrames } = require('./persona-catalog');

const { PRINCIPAL_MODEL_ALIAS } = require('../../src/services/routing/principalAlias');

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

function screenReference(view) {
  if (!view) return '';
  const { artx, ...screen } = view;
  const pieces = [];
  for (const [name, evidence] of [['screen', screen], ['ArtX', artx]]) {
    if (!evidence || !Object.keys(evidence).length || evidence.status === 'none') continue;
    const data = JSON.stringify(evidence);
    // Keep whole, already validated observations. A larger view stays with
    // the worker; its title alone is never evidence of its contents.
    pieces.push(data.length <= 1100 ? name + ': ' + data : name + ': ' +
      JSON.stringify({ title: evidence.title, status: evidence.status, details: 'consult the scoped source for content' }));
  }
  return pieces.join('\n');
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
    'parler : causerie, explication, culture générale, imagination, faits fournis ou question de clarification. Utilise aussi tes connaissances générales. consulter : il faut vérifier une donnée personnelle ou actuelle absente, agir, lire une source ou approfondir une analyse. ' +
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

async function decide(request, inference, consumerContract, env, targetFor = pinned, principalConversation) {
  const messages = messagesFor(request);
  if (!messages || require('../../src/services/voice/presentation').readingRequested(request.text)) return { mode: 'consulter' };
  const principal = env.HOUSEHOLD_SPOKEN_HOST === PRINCIPAL_MODEL_ALIAS;
  const target = principal ? null : await targetFor(env.HOUSEHOLD_SPOKEN_HOST);
  const body = { mode: 'chat', model: target?.model || PRINCIPAL_MODEL_ALIAS, messages, format: decisionSchema,
    think: false, stream: true, temperature: 0, max_tokens: request.pack.maxTokens,
    callerDetail: 'agentx-household/spoken-dialogue', timeoutMs: 60000 };
  const routed = principal && principalConversation ? await principalConversation(body) : null;
  if (['backup', 'status_only'].includes(routed?.metadata?.conversationContinuity?.state)) {
    // The ordinary reply loop owns the original admitted relay stream, tools and receipts.
    return { mode: 'relay', result: routed };
  }
  const result = routed ?? await inference.execute(body, { ...(target && { hostUrl: target.hostUrl }),
    consumerContract, signal: request.signal, retry: { enabled: false } });
  if (!result?.ok || !result.stream || !result.completion?.then) throw failure('The local voice stream is unavailable.');
  // A second utterance can stop delivery during generation. Core drains
  // the admitted stream and verifies its release before we acknowledge the stop.
  let frames, usage;
  try {
    frames = await readReplyFrames(result.stream, () => {}, request.signal, { allowLength: true });
  } finally {
    usage = await result.completion;
  }
  if (request.signal?.aborted) {
    await request.onSettled?.();
    request.signal.throwIfAborted();
  }
  const { terminal, text, toolCalls } = frames;
  if (!result.metadata?.hostUrl || !terminal?.model || terminal.model !== (target?.model || result.metadata.model)
      || (target && result.metadata.hostUrl !== target.hostUrl) || toolCalls.length) {
    throw failure('The local voice model did not return a complete decision.');
  }
  if (terminal.done_reason === 'length') return { mode: 'consulter', body: usage };
  if (terminal.done_reason !== 'stop') throw failure('The local voice decision did not finish.');
  let choice;
  try { choice = JSON.parse(text); } catch { /* Invalid output has no authority. */ }
  if (!choice || !['parler', 'consulter'].includes(choice.mode) || typeof choice.texte !== 'string'
      || (choice.mode === 'parler' && !choice.texte.trim()) || /<\/?(?:show|consult|secret|say|written|sound|page|math)\b/i.test(choice.texte) || Object.keys(choice).some(key => !['mode', 'texte'].includes(key))) throw failure('Invalid local voice decision.');
  return { ...choice, texte: choice.texte.trim(), metadata: result.metadata, body: usage };
}

module.exports = { enabled, followupHistory, screenReference, pinned, decide, messagesFor, forTurn };
