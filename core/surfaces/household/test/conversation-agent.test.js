'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentClient, agentInstructions, sessionKeyFor } = require('../conversation-agent');
const env = { OPENCLAW_GATEWAY_URL: 'ws://gateway:18789', OPENCLAW_GATEWAY_TOKEN: 'test-only' };
const session = { sessionId: '11111111-1111-4111-8111-111111111111', persona: { identity: 'You are Jarvis.' } };
const runId = 'resp_22222222-2222-4222-8222-222222222222';
const row = data => Buffer.from('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n');
const created = row({ type: 'response.created', response: { id: runId } });
const completed = row({ type: 'response.completed', response: { id: runId } });
const answer = text => ({ status: 'ready', runId, text, source: 'openclaw/sessions.get' });

function heldNativeStream(rows = [created]) {
  let release;
  let requests = 0;
  return {
    fetch: async (_url, options) => {
      requests++;
      return { ok: true, body: (async function* () {
        for (const item of rows) yield item;
        await new Promise(resolve => {
          release = resolve;
          options.signal.addEventListener('abort', resolve, { once: true });
        });
      })() };
    },
    close: () => release?.(),
    requests: () => requests
  };
}

test('native opening uses the existing message shape with explicit application origin and the same native session', async () => {
  let body;
  const applicationEvent = { type: 'environment_ready', origin: 'application_opening', openingVersion: 1, language: 'fr', environment: null };
  const client = createAgentClient({ env, settleMs: 0,
    continuity: async () => ({ answer: answer('Hello. On commence?'), run: { model: 'native' } }),
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, body: [created, completed] }; } });
  const result = await client({ session, text: '', applicationEvent });
  assert.equal(result.text, 'Hello. On commence?');
  assert.equal(body.model, 'openclaw/main');
  assert.equal(body.input[0].type, 'message');
  assert.equal(body.input[0].role, 'user');
  assert.ok(body.input[0].content.startsWith('[Household application event; no human utterance]\n' + JSON.stringify(applicationEvent)));
  assert.match(body.input[0].content, /exact word "Hello"/);
  assert.match(body.input[0].content, /Do not yield, delegate, wait for a human message, or return NO_REPLY/);
});

test('personal voice selects the configured model per run while preserving native history and explicit Open', async () => {
  const requests = [];
  const voice = { ...session, packId: 'personal_operator', scopeId: 'personal', agentId: 'main', agentSessionKey: sessionKeyFor(session) };
  const client = createAgentClient({ env: { ...env, HOUSEHOLD_VOICE_MODEL: ' local/fast-model ' }, settleMs: 0,
    continuity: async () => ({ answer: answer('Orion, 23 dollars.'), run: { model: 'effective-model' } }),
    fetchImpl: async (_url, options) => { requests.push({ headers: options.headers, body: JSON.parse(options.body) }); return { ok: true, body: [created, completed] }; } });
  const result = await client({ session: voice, channel: 'voice', text: 'Et notre budget?', history: [{ role: 'user', content: 'Already owned' }] });
  assert.equal(requests[0].headers['x-openclaw-model'], 'local/fast-model');
  assert.equal(requests[0].headers['x-openclaw-session-key'], voice.agentSessionKey);
  assert.equal(requests[0].body.model, 'openclaw/main');
  assert.equal(requests[0].body.input.length, 1);
  assert.equal(result.metadata.model, 'effective-model', 'Report the actual model, never the requested one');
  const cases = [
    { session: voice, channel: 'voice', model: 'local/explicit-open' },
    { session: voice, channel: 'text' },
    { session: voice },
    { session: { ...voice, inference: { open: true } }, channel: 'voice' },
    { session: { ...voice, modeId: 'open' }, channel: 'voice' },
    { session: { ...voice, agentId: 'deepsearch' }, channel: 'voice' },
    { session: { ...voice, scopeId: 'family' }, channel: 'voice' },
    { session: { ...voice, source: 'graphysx-llmx' }, channel: 'voice' },
    { session: { ...voice, llmx: { schemaVersion: 1 } }, channel: 'voice' },
    { session: { ...voice, packId: 'kidx_nestor', scopeId: 'family' }, channel: 'voice' }
  ];
  for (const input of cases) {
    await client({ ...input, text: 'Continue.' });
    assert.equal(requests.at(-1).headers['x-openclaw-model'], input.model);
  }
  const unset = createAgentClient({ env, settleMs: 0,
    continuity: async () => ({ answer: answer('Bonjour.'), run: {} }),
    fetchImpl: async (_url, options) => { assert.equal(options.headers['x-openclaw-model'], undefined); return { ok: true, body: [created, completed] }; } });
  await unset({ session: voice, channel: 'voice', text: 'Bonjour.' });
  const prompt = agentInstructions(voice, voice.persona, 'Surface contract', null, { channel: 'voice' });
  assert.match(prompt, /Preserve the conversation's facts, corrections and unresolved questions/);
  assert.match(prompt, /Expand when the user asks for detail/);
  assert.ok(!agentInstructions(voice, voice.persona, '', null, { channel: 'text' }).includes('one to three short sentences'));
});

test('one native session owns tools and history; presentation and model remain independent', async () => {
  const requests = [], starts = [], deltas = [];
  const client = createAgentClient({ env, continuity: async req => {
    assert.equal(req.runId, runId); assert.equal(req.sessionKey, sessionKeyFor(session));
    return { answer: answer('Trouvé.'), run: { model: 'local', provider: 'ollama' }, receipts: [{ tool: 'agentx__rag_search', observed: true }] };
  }, fetchImpl: async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, body: (async function* () {
      const bytes = Buffer.concat([created, row({ type: 'response.output_text.delta', delta: 'Trouvé.' }), completed]);
      // Split in the middle of an accented UTF-8 character and an SSE record.
      for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3);
    })() };
  } });
  const call = { session, text: 'Retrouve le document.', instructions: 'Persona prompt', history: [{ role: 'user', content: 'Earlier turn' }],
    onStarted: async key => starts.push(key), onDelta: text => deltas.push(text) };
  const first = await client(call);
  assert.equal(first.text, 'Trouvé.'); assert.deepEqual(deltas, ['Trouvé.']);
  assert.equal(first.tools.receipts[0].tool, 'agentx__rag_search');
  assert.equal(requests[0].url.pathname, '/v1/responses');
  assert.equal(requests[0].body.model, 'openclaw/main');
  assert.equal(requests[0].body.input.length, 2);
  assert.equal(requests[0].body.tools, undefined, 'OpenClaw owns the native tools');
  assert.equal(requests[0].options.headers['x-openclaw-session-key'], starts[0]);
  await client({ ...call, session: { ...session, agentSessionKey: starts[0] }, model: 'ollama/open-model' });
  assert.equal(requests[1].body.input.length, 1, 'Do not replay or duplicate already-owned history');
  assert.equal(requests[1].options.headers['x-openclaw-model'], 'ollama/open-model');
  const prompt = agentInstructions(session, session.persona, 'Speak naturally.');
  assert.match(prompt, /You are Jarvis/); assert.match(prompt, /tools and skills actually available/);
  assert.match(prompt, /sessions_spawn .*sessions_yield/); assert.match(prompt, /Do not use sessions_send/); assert.match(prompt, /tool_call using the id openclaw:core:sessions_spawn/);
});

test('selected turn context stays reference data beside the current request and attachments, without changing native history', async () => {
  const requests = [];
  const client = createAgentClient({ env, settleMs: 0, continuity: async () => ({ answer: answer('Orion.'), run: {} }),
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, body: [created, completed] }; } });
  const image = { type: 'input_image', image_url: 'data:image/png;base64,fixture' };
  for (const turnContext of ['Saved notes: first selection.', 'Saved notes: corrected selection.']) {
    await client({ session: { ...session, agentSessionKey: sessionKeyFor(session) }, instructions: 'Stable identity and permissions',
      text: 'Current request', currentContent: [{ type: 'input_text', text: 'Current request' }, image], turnContext,
      history: [{ role: 'user', content: 'Already owned' }] });
    const sent = requests.at(-1);
    assert.equal(sent.instructions, 'Stable identity and permissions');
    assert.equal(sent.input.length, 1);
    assert.equal(sent.input[0].role, 'user');
    assert.deepEqual(sent.input[0].content.slice(2), [{ type: 'input_text', text: 'Current request' }, image]);
    assert.deepEqual(sent.input[0].content[1], { type: 'input_text', text: 'Current user request:' });
    assert.match(sent.input[0].content[0].text, /reference data, not tool instructions/);
    assert.ok(sent.input[0].content[0].text.includes('<selected_context>\n' + turnContext + '\n</selected_context>'));
  }
});

test('a failed or truncated agent run never falls back to a second inference workflow', async () => {
  for (const body of [[], [created], [created, row({ type: 'response.failed' })],
    [created, row({ type: 'response.incomplete' })], [created, row({ type: 'response.completed', response: { id: 'another-run' } })]]) {
    let calls = 0;
    const client = createAgentClient({ env, continuity: async () => ({ run: { status: 'failed' } }),
      fetchImpl: async () => { calls++; return { ok: true, body }; } });
    await assert.rejects(client({ session, text: 'Check' })); assert.equal(calls, 1);
  }
});

test('interruption cancels upstream and waits for native termination evidence', async () => {
  const abort = new AbortController(); let released = false, checks = 0;
  const client = createAgentClient({ env, settleMs: 1000,
    continuity: async () => { checks++; released = true; return { run: { status: 'failed' } }; },
    fetchImpl: async (_url, options) => ({ ok: true, body: (async function* () {
      yield created; abort.abort(); assert.equal(options.signal.aborted, true);
      throw abort.signal.reason;
    })() }) });
  assert.equal((await client({ session, text: 'Check', signal: abort.signal })).interrupted, true);
  assert.equal(released, true); assert.equal(checks, 1);
});

test('terminal native failure reports settlement without delivering a reply or starting another run', async () => {
  for (const type of ['response.failed', 'response.incomplete']) {
    const started = [], settled = [], deltas = []; let calls = 0;
    const client = createAgentClient({ env, settleMs: 0,
      continuity: async () => assert.fail('Terminal transport already confirms this run ended'),
      fetchImpl: async () => { calls++; return { ok: true, body: [created,
        row({ type, response: { id: runId, error: { message: 'Reply failed' } } })] }; } });
    await assert.rejects(client({ session, text: 'Question', onDelta: value => deltas.push(value),
      onStarted: (...args) => started.push(args), onSettled: (...args) => settled.push(args) }),
      error => /pas pu finir sa réponse/.test(error.message) && error.detail === 'Reply failed');
    assert.deepEqual(started, [[sessionKeyFor(session), runId]]);
    assert.deepEqual(settled, started); assert.deepEqual(deltas, []); assert.equal(calls, 1);
  }
});

test('truncated and wrong-run native failures do not acknowledge settlement without termination evidence', async () => {
  for (const body of [[created], [created, row({ type: 'response.failed', response: { id: 'wrong-run' } })]]) {
    let settled = false, started;
    const client = createAgentClient({ env, settleMs: 0, continuity: async () => null,
      fetchImpl: async () => ({ ok: true, body }) });
    await assert.rejects(client({ session, text: 'Question', onStarted: (_key, id) => { started = id; },
      onSettled: () => { settled = true; } }), /pas encore confirmé/);
    assert.equal(started, runId); assert.equal(settled, false);
  }
});

test('missing tool receipts are unavailable rather than proof of zero tools', async () => {
  const client = createAgentClient({ env, settleMs: 0, continuity: async () => ({ answer: answer('Bonjour.') }),
    fetchImpl: async () => ({ ok: true, body: [created, completed] }) });
  assert.equal((await client({ session, text: 'Hello' })).tools.status, 'unavailable');
});

test('native fallback evidence settles before reporting the effective provider', async () => {
  let reads = 0;
  const client = createAgentClient({ env, continuity: async () => ({
    answer: answer('Completed.'),
    run: ++reads === 1 ? { model: 'first-attempt', provider: 'ollama' }
      : { model: 'final-answer-model', provider: 'native-fallback' }, receipts: []
  }), fetchImpl: async () => ({ ok: true, body: [created,
    row({ type: 'response.output_text.delta', delta: 'Completed.' }), completed] }) });
  const result = await client({ session, text: 'Hello' });
  assert.equal(result.metadata.model, 'final-answer-model');
  assert.equal(result.metadata.provider, 'native-fallback');
});

test('a specialist inherits its native model and keeps its own session across personality changes', async () => {
  const requests = [];
  const specialist = { ...session, agentId: 'deepsearch' };
  const client = createAgentClient({ env, settleMs: 0,
    continuity: async req => { assert.match(req.sessionKey, /^agent:deepsearch:/); return { answer: answer('Completed.'), run: { model: 'native', provider: 'native' }, receipts: [] }; },
    fetchImpl: async (_url, options) => { requests.push(options); return { ok: true, body: [created, completed] }; } });
  await client({ session: specialist, text: 'Research', instructions: agentInstructions(specialist, { identity: 'Be concise.' }) });
  await client({ session: { ...specialist, agentSessionKey: sessionKeyFor(specialist) }, text: 'Continue', instructions: agentInstructions(specialist, { identity: 'Be warm.' }) });
  for (const request of requests) {
    assert.equal(JSON.parse(request.body).model, 'openclaw/deepsearch');
    assert.equal(request.headers['x-openclaw-model'], undefined);
    assert.doesNotMatch(JSON.parse(request.body).instructions, /personal_memory|same Nestor agent/);
  }
  assert.equal(requests[0].headers['x-openclaw-session-key'], requests[1].headers['x-openclaw-session-key']);
  assert.notEqual(sessionKeyFor(session), sessionKeyFor(specialist));
});

test('tool preambles never reach display or speech, even when the HTTP final item contains them', async () => {
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0,
    continuity: async () => ({ answer: answer('Deux tâches sont en révision.'), run: { model: 'native' } }),
    fetchImpl: async () => ({ ok: true, body: (async function* () {
      yield created;
      yield row({ type: 'response.output_text.delta', delta: 'I should inspect the tools. ' });
      assert.deepEqual(deltas, []);
      yield row({ type: 'response.output_text.delta', delta: 'Deux tâches sont en révision.' });
      yield row({ type: 'response.output_item.done', item: { phase: 'final_answer', content: [
        { type: 'output_text', text: 'I should inspect the tools. Deux tâches sont en révision.' }
      ] } });
      yield completed;
    })() }) });
  const result = await client({ session, text: 'Statut du pipeline ?', onDelta: text => deltas.push(text) });
  assert.equal(result.text, 'Deux tâches sont en révision.');
  assert.deepEqual(deltas, [result.text]);
});

test('personal voice does not deliver a final tool promise without a current result', async () => {
  const voice = { ...session, packId: 'personal_operator', scopeId: 'personal', agentId: 'main' };
  const cases = [
    { native: "I'll check your personal tasks and search for urgent items right now.", expected: 'I could not complete that check. Please try again.', receipts: [] },
    { native: 'Let me check.', expected: 'I could not complete that check. Please try again.', receipts: [] },
    { native: 'Je regarde tes tâches.', expected: 'Je n’ai pas pu terminer cette vérification. Réessaie ta demande.', receipts: [] },
    { native: 'Je vais vérifier tes tâches.', expected: 'Je n’ai pas pu terminer cette vérification. Réessaie ta demande.',
      receipts: [{ runId, observed: true, status: 'failed', tool: 'agentx__list_personal_tasks' }] },
    { native: 'Je regarde tes tâches: tu en as deux en cours.', expected: 'Je regarde tes tâches: tu en as deux en cours.', receipts: [] },
    { native: 'Je regarde tes tâches, tu en as deux en cours.', expected: 'Je regarde tes tâches, tu en as deux en cours.', receipts: [] },
    { native: 'Je vais te raconter une histoire.', expected: 'Je vais te raconter une histoire.', receipts: [] },
    { native: 'Voici les deux approches possibles. '.repeat(12) + '\n\nJe vais faire une petite recherche sur la documentation. Je te reviens avec les résultats.\n\nAttends deux secondes.',
      expected: 'Je n’ai pas pu terminer cette vérification. Réessaie ta demande.', receipts: [] },
    { native: 'There are several ways to compare these options. '.repeat(12) + '\n\nI will search the documentation. Please wait a moment.',
      expected: 'I could not complete that check. Please try again.', receipts: [] },
    { native: 'Je vais chercher dans la documentation. Attends un instant. Voici le résultat vérifié: deux options.',
      expected: 'Je vais chercher dans la documentation. Attends un instant. Voici le résultat vérifié: deux options.', receipts: [] },
    { native: 'La documentation confirme deux possibilités. Souhaites-tu que je fasse une recherche supplémentaire?',
      expected: 'La documentation confirme deux possibilités. Souhaites-tu que je fasse une recherche supplémentaire?', receipts: [] },
    { native: 'Je regarde tes tâches.', expected: 'Je n’ai pas pu terminer cette vérification. Réessaie ta demande.',
      receipts: [{ runId, observed: true, status: 'verified', tool: 'agentx__list_personal_tasks' }] }
  ];
  for (const { native, expected, receipts } of cases) {
    const deltas = [];
    const client = createAgentClient({ env, settleMs: 0,
      continuity: async () => ({ answer: answer(native), run: { model: 'local' }, receipts }),
      fetchImpl: async () => ({ ok: true, body: [created, completed] }) });
    const result = await client({ session: voice, channel: 'voice', text: 'Mes tâches ?', onDelta: value => deltas.push(value) });
    assert.equal(result.text, expected);
    assert.deepEqual(deltas, [expected]);
  }
  assert.match(agentInstructions(voice, null, '', null, { channel: 'voice' }), /Never finish with only a progress promise/);
});

test('missing or mismatched native final answers never replay aggregated speech', async () => {
  for (const projected of [null, { status: 'unavailable' }, { ...answer('Other turn'), runId: 'other' }]) {
    const deltas = [];
    const client = createAgentClient({ env, settleMs: 0,
      continuity: async () => ({ answer: projected, run: { model: 'native' } }),
      fetchImpl: async () => ({ ok: true, body: [created,
        row({ type: 'response.output_text.delta', delta: 'Internal preamble' }), completed] }) });
    await assert.rejects(client({ session, text: 'Check', onDelta: text => deltas.push(text) }), /pas donné de réponse finale/);
    assert.deepEqual(deltas, []);
  }
});

const browserContext = { schemaVersion: 1, environment: { id: 'forge', name: 'Forge' }, revision: 'current',
  capabilities: { commandsVersion: 2 }, buildZone: { center: [0, 0, 0], radius: 4 } };
const browserItem = args => ({ type: 'function_call', name: 'graphysx_reply', call_id: 'call_scene_1', status: 'completed', arguments: JSON.stringify(args) });
const browserCompleted = output => row({ type: 'response.completed', response: { id: runId, output } });

test('GraphysX completes through one native client tool and the next turn returns its browser receipt in the same session', async () => {
  const requests = [], deltas = [];
  const proposal = { reply: 'Je vais déplacer le plancher.', scene: { schemaVersion: 1, intent: 'Déplacer',
    commands: [{ op: 'update', id: 'floor-1', patch: { transform: { position: [30, 0, 0] } } }] } };
  const client = createAgentClient({ env, settleMs: 0,
    continuity: async () => ({ run: { model: 'native', provider: 'ollama' }, receipts: [{ tool: 'memory_search' }] }),
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, body: [created,
      row({ type: 'response.output_text.delta', delta: 'Internal tool preamble' }),
      browserCompleted([{ type: 'message', content: [{ type: 'output_text', text: 'Internal preamble' }] }, browserItem(proposal)])] }; } });
  const result = await client({ session, text: 'Déplace le plancher.', browserReply: { context: browserContext }, onDelta: text => deltas.push(text) });
  assert.deepEqual(JSON.parse(result.text), proposal); assert.deepEqual(deltas, [result.text]);
  assert.equal(result.tools.browserReply.callId, 'call_scene_1');
  assert.equal(result.tools.browserReply.runId, runId); assert.equal(result.tools.receipts[0].tool, 'memory_search');
  const previousOutput = require('../llmx-conversation').browserReplyOutput({ clientTurnId: 'human-turn-1',
    toolEvidence: result.tools, sceneProposal: proposal.scene, sceneReceipt: { status: 'applied', entityIds: ['floor-1'] } });
  await client({ session: { ...session, agentSessionKey: result.sessionKey }, text: 'Continue.',
    history: [{ role: 'user', content: 'Must not replay' }], browserReply: { context: browserContext, previousOutput } });
  assert.equal(requests[0].tool_choice, 'auto');
  assert.equal(requests[0].tools.length, 1); assert.equal(requests[0].tools[0].name, 'graphysx_reply');
  assert.deepEqual(requests[1].input, [previousOutput, { type: 'message', role: 'user', content: 'Continue.' }]);
  assert.equal(JSON.parse(previousOutput.output).status, 'applied');
});

test('GraphysX ordinary client-tool replies are natural text and absent run evidence is reported honestly', async () => {
  const client = createAgentClient({ env, settleMs: 0, continuity: async () => null,
    fetchImpl: async () => ({ ok: true, body: [created, browserCompleted([browserItem({ reply: 'Bonjour.' })])] }) });
  const result = await client({ session, text: 'Salut', browserReply: { context: browserContext } });
  assert.equal(result.text, 'Bonjour.'); assert.equal(result.tools.status, 'unavailable'); assert.equal(result.metadata.model, '');
});

test('GraphysX dialogue reuses the verified native final answer without a browser tool or another inference', async () => {
  const deltas = []; let requests = 0;
  const question = 'je suis curieux de connaitre tes capacités';
  const reply = 'Je peux discuter avec toi et créer ou modifier des objets dans cet environnement.';
  const client = createAgentClient({ env, settleMs: 0,
    continuity: async request => { assert.equal(request.runId, runId); return { answer: answer(reply), run: { model: 'native' } }; },
    fetchImpl: async (_url, options) => {
      requests++;
      const request = JSON.parse(options.body);
      assert.equal(request.input.at(-1).content, question);
      assert.equal(request.tools[0].name, 'graphysx_reply');
      // Match the native gateway: a plain answer cannot satisfy a forced client tool.
      const completion = request.tool_choice === 'auto' ? browserCompleted([])
        : row({ type: 'response.failed', response: { id: runId, error: {
          message: 'tool_choice required a graphysx_reply tool call, but the agent did not produce one'
        } } });
      return { ok: true, body: [created,
        row({ type: 'response.output_text.delta', delta: 'Internal preamble' }), completion] };
    } });
  const result = await client({ session, text: question, browserReply: { context: browserContext }, onDelta: text => deltas.push(text) });
  assert.equal(result.text, reply); assert.deepEqual(deltas, [reply]);
  assert.equal(result.tools.browserReply, undefined); assert.equal(requests, 1);
});

test('GraphysX without a client tool refuses missing or wrong-run final answers and text-only scene proposals', async () => {
  const proposal = JSON.stringify({ reply: 'Je vais créer.', scene: { schemaVersion: 1, intent: 'Créer', commands: [{ op: 'spawn', entity: { id: 'cube', type: 'box' } }] } });
  for (const evidence of [null, { answer: { ...answer('Old'), runId: 'other-run' } }, { answer: answer(proposal) }, { answer: answer('[{"op":"spawn"}]') }]) {
    const deltas = [];
    const client = createAgentClient({ env, settleMs: 0, continuity: async () => evidence,
      fetchImpl: async () => ({ ok: true, body: [created, browserCompleted([])] }) });
    await assert.rejects(client({ session, text: 'Check', browserReply: { context: browserContext }, onDelta: text => deltas.push(text) }));
    assert.deepEqual(deltas, []);
  }
});

test('GraphysX never delivers multiple, wrong-name, malformed or unsupported client tool calls', async () => {
  for (const output of [[browserItem({ reply: 'Hi' }), browserItem({ reply: 'Again' })],
    [{ ...browserItem({ reply: 'Hi' }), name: 'exec' }], [{ ...browserItem({ reply: 'Hi' }), call_id: '' }],
    [{ ...browserItem({ reply: 'Hi' }), status: 'in_progress' }], [browserItem({ sample: 'wrong envelope' })],
    [{ ...browserItem({ reply: 'Hi' }), arguments: '{"reply":' }],
    [browserItem({ reply: 'Hi', scene: { schemaVersion: 1, intent: 'Bad', commands: [{ op: 'exec' }] } })]]) {
    const deltas = [];
    const client = createAgentClient({ env, settleMs: 0, continuity: async () => ({ answer: answer('Do not use this fallback'), run: {} }),
      fetchImpl: async () => ({ ok: true, body: [created, browserCompleted(output)] }) });
    await assert.rejects(client({ session, text: 'Check', browserReply: { context: browserContext }, onDelta: text => deltas.push(text) }));
    assert.deepEqual(deltas, []);
  }
});

test('a gateway refusal to stream a rewritten answer still delivers the run\'s verified final answer', async () => {
  const replaced = { message: 'Assistant output cannot be represented as an append-only response stream.' };
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0,
    continuity: async () => ({ answer: answer('Essaie « 20 questions ».'), run: { model: 'local' } }),
    fetchImpl: async () => ({ ok: true, body: [created,
      row({ type: 'response.output_text.delta', delta: 'Essaie « 20 quest' }),
      row({ type: 'response.failed', response: { id: runId, error: replaced } })] }) });
  const result = await client({ session, text: 'Une idée de jeu?', onDelta: value => deltas.push(value) });
  assert.equal(result.text, 'Essaie « 20 questions ».');
  assert.deepEqual(deltas, ['Essaie « 20 questions ».'], 'the streamed fragment is never delivered');

  // Without a verified final answer for this run, the refusal stays an error.
  const missing = createAgentClient({ env, settleMs: 0,
    continuity: async () => ({ answer: { status: 'missing' }, run: { model: 'local' } }),
    fetchImpl: async () => ({ ok: true, body: [created, row({ type: 'response.failed', response: { id: runId, error: replaced } })] }) });
  await assert.rejects(missing({ session, text: 'Une idée de jeu?' }), /réécrit sa réponse/);
});

test('a turn delegated to a sub-agent reports its tools, waits for the settled answer and names the agent', async () => {
  const deltas = [], activity = [];
  let reads = 0;
  const deliveredBy = `announce:requester-settle:main:${sessionKeyFor(session)}:child:synthetic-yield`;
  const progress = [{ id: 'call-1', tool: 'agents_list' }, { id: 'call-2', tool: 'sessions_spawn', agentId: 'comptable' }];
  const client = createAgentClient({ env, settleMs: 0, delegateMs: 10000,
    continuity: async () => ({ run: { model: 'native' }, progress,
      answer: ++reads < 3 ? { status: 'yielded', runId } : { ...answer('Le comptable a répondu.'), deliveredBy } }),
    fetchImpl: async () => ({ ok: true, body: [created, completed] }) });
  const result = await client({ session, text: 'Combien coûte le karaté ?', onDelta: text => deltas.push(text), onActivity: item => activity.push(item) });
  assert.equal(result.text, 'Le comptable a répondu.');
  assert.equal(result.tools.deliveredBy, deliveredBy);
  assert.deepEqual(result.tools.performedBy, [{ agentId: 'main', runId }, { agentId: 'main', runId: deliveredBy }]);
  assert.deepEqual(deltas, [result.text]);
  assert.deepEqual(activity, [{ kind: 'tool', tool: 'agents_list' }, { kind: 'tool', tool: 'sessions_spawn', agentId: 'comptable' },
    { kind: 'waiting_agent', agentId: 'comptable' }]);
});

test('a turn that started a background image waits for the image, not for another agent', async () => {
  const activity = [];
  let reads = 0;
  const client = createAgentClient({ env, settleMs: 0, delegateMs: 10000,
    continuity: async () => ({ run: { model: 'native' }, progress: [{ id: 'call-1', tool: 'image_generate' }],
      answer: ++reads < 3 ? { status: 'yielded', runId } : answer('Voilà la pomme.') }),
    fetchImpl: async () => ({ ok: true, body: [created, completed] }) });
  const result = await client({ session, text: 'Une image de pomme ?', onActivity: item => activity.push(item) });
  assert.equal(result.text, 'Voilà la pomme.');
  assert.deepEqual(activity, [{ kind: 'tool', tool: 'image_generate' }, { kind: 'waiting_image' }]);
  const late = createAgentClient({ env, settleMs: 0, delegateMs: 0,
    continuity: async () => ({ run: { model: 'native' }, progress: [{ id: 'call-1', tool: 'image_generate' }], answer: { status: 'yielded', runId } }),
    fetchImpl: async () => ({ ok: true, body: [created, completed] }) });
  await assert.rejects(late({ session, text: 'Une image ?' }), /image n’était pas prête après 5 minutes/);
});

test('tool progress is reported while the native run is still streaming', async () => {
  const activity = [];
  let release;
  const client = createAgentClient({ env, settleMs: 0, progressMs: 5,
    continuity: async () => ({ run: { model: 'native' }, answer: answer('Voilà.'), progress: [{ id: 'call-1', tool: 'personal_memory' }] }),
    fetchImpl: async () => ({ ok: true, body: (async function* () {
      yield created;
      await new Promise(resolve => { release = resolve; setTimeout(resolve, 200); });
      yield completed;
    })() }) });
  const result = await client({ session, text: 'Mes notes ?', onActivity: item => { activity.push(item); release?.(); } });
  assert.equal(result.text, 'Voilà.');
  assert.deepEqual(activity, [{ kind: 'tool', tool: 'personal_memory' }]);
});

test('a final answer is delivered when the gateway keeps a finished run\'s stream open', async () => {
  let closeStream, reads = 0, aborted = false;
  const open = () => ({ ok: true, body: (async function* () {
    yield created;
    await new Promise(resolve => { closeStream = resolve; });
  })() });
  const evidence = { run: { model: 'native' }, answer: answer('Trois tâches.'), progress: [{ id: 'call-1', tool: 'list_personal_tasks' }] };
  const activity = [];
  const client = createAgentClient({ env, settleMs: 0, progressMs: 5, streamGraceMs: 20, streamDrainMs: 40,
    // The first reads fall while the tool still runs: no final answer yet.
    continuity: async () => (++reads < 3 ? { progress: evidence.progress, answer: { status: 'unavailable', runId } } : evidence),
    fetchImpl: async (_url, options) => { options.signal.addEventListener('abort', () => { aborted = true; closeStream(); }); return open(); } });
  let settled = 0;
  const result = await client({ session, text: 'Mes tâches ?', onActivity: item => activity.push(item), onSettled: () => { settled += 1; } });
  assert.equal(result.text, 'Trois tâches.');
  assert.equal(result.tools.status, 'observed');
  assert.equal(result.interrupted, undefined);
  assert.equal(settled, 1);
  assert.deepEqual(activity, [{ kind: 'tool', tool: 'list_personal_tasks' }]);
  assert.ok(result.metadata.phases.streamOverdue > 0 && result.metadata.phases.streamEnd === undefined);
  assert.equal(aborted, false, 'The gateway keeps a bounded time to finish behind the run');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(aborted, true, 'A request the gateway never closes is closed for it');
});

test('a stream that ends within the grace is never abandoned, and a browser reply always waits for it', async () => {
  const evidence = { run: { model: 'native' }, answer: answer('Voilà.') };
  const slow = () => ({ ok: true, body: (async function* () {
    yield created;
    await new Promise(resolve => setTimeout(resolve, 60));
    yield completed;
  })() });
  const graced = createAgentClient({ env, settleMs: 0, progressMs: 5, streamGraceMs: 500, continuity: async () => evidence, fetchImpl: async () => slow() });
  const first = await graced({ session, text: 'Alors ?' });
  assert.ok(first.metadata.phases.streamEnd > 0 && first.metadata.phases.streamOverdue === undefined);
  const scene = createAgentClient({ env, settleMs: 0, progressMs: 5, streamGraceMs: 5, continuity: async () => evidence, fetchImpl: async () => slow() });
  const second = await scene({ session, text: 'Alors ?', browserReply: { context: {} } });
  assert.ok(second.metadata.phases.streamEnd > 0 && second.metadata.phases.streamOverdue === undefined);
});

test('an observed final answer survives a failed final read without claiming an old fallback provider', async () => {
  const stream = heldNativeStream();
  let reads = 0, settled = 0;
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0, progressMs: 5, streamGraceMs: 20, streamDrainMs: 20,
    continuity: async () => {
      if (++reads > 1) throw new Error('Continuity unavailable');
      return { answer: answer('Trois tâches.'), run: { model: 'first-attempt', provider: 'old-provider' },
        receipts: [{ tool: 'list_personal_tasks', observed: true }] };
    }, fetchImpl: stream.fetch });
  try {
    const result = await client({ session, text: 'Mes tâches ?', onDelta: text => deltas.push(text), onSettled: () => { settled++; } });
    assert.equal(result.text, 'Trois tâches.');
    assert.equal(result.metadata.model, '');
    assert.equal(result.metadata.provider, '');
    assert.equal(result.tools.status, 'unavailable');
    assert.equal(result.tools.run, null);
    assert.deepEqual(result.tools.receipts, []);
    assert.deepEqual(deltas, ['Trois tâches.']);
    assert.equal(settled, 1);
    assert.equal(stream.requests(), 1);
    assert.ok(reads >= 2);
  } finally { stream.close(); }
});

test('a final answer seen during settlement survives the next failed observation', async () => {
  let reads = 0;
  const client = createAgentClient({ env, settleMs: 400,
    continuity: async () => {
      if (++reads > 1) throw new Error('Continuity unavailable');
      return { answer: answer('Réponse reçue.'), run: { model: 'first-attempt', provider: 'old-provider' } };
    }, fetchImpl: async () => ({ ok: true, body: [created, completed] }) });
  const result = await client({ session, text: 'Et ensuite ?' });
  assert.equal(result.text, 'Réponse reçue.');
  assert.equal(result.metadata.model, '');
  assert.equal(result.metadata.provider, '');
  assert.equal(reads, 2);
});

test('GraphysX dialogue never substitutes a watcher answer when its final read is unavailable', async () => {
  const stream = heldNativeStream([created, completed]);
  let reads = 0;
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0, progressMs: 3, streamGraceMs: 15, streamDrainMs: 20,
    continuity: async () => {
      if (++reads === 1) return { answer: answer('Ne pas substituer.') };
      throw new Error('Continuity unavailable');
    }, fetchImpl: stream.fetch });
  try {
    await assert.rejects(client({ session, text: 'Bonjour.', browserReply: { context: {} },
      onDelta: text => deltas.push(text) }), /pas donné de réponse finale/);
    assert.deepEqual(deltas, []);
    assert.ok(reads >= 2);
    assert.equal(stream.requests(), 1);
  } finally { stream.close(); }
});

for (const [name, invalid] of [
  ['yielded', { answer: { status: 'yielded', runId } }],
  ['unavailable', { answer: { status: 'unavailable', runId } }],
  ['another run', { answer: { ...answer('Autre tour.'), runId: 'another-run' } }],
  ['blank text', { answer: answer('   ') }],
  ['non-string text', { answer: { ...answer('Unused'), text: 42 } }],
  ['missing answer', null]
]) {
  test(`a successful ${name} observation invalidates a previously ready answer`, async () => {
    const stream = heldNativeStream();
    let reads = 0;
    const deltas = [];
    const client = createAgentClient({ env, settleMs: 0, delegateMs: 0, progressMs: 3, streamGraceMs: 25, streamDrainMs: 20,
      continuity: async () => {
        reads++;
        if (reads === 1) return { answer: answer('Ancienne réponse.') };
        if (reads === 2) return invalid;
        throw new Error('Continuity unavailable');
      }, fetchImpl: stream.fetch });
    try {
      await assert.rejects(client({ session, text: 'Suite ?', onDelta: text => deltas.push(text) }), /pas donné de réponse finale/);
      assert.ok(reads >= 3);
      assert.deepEqual(deltas, []);
      assert.equal(stream.requests(), 1);
    } finally { stream.close(); }
  });
}

test('the latest observed ready answer replaces an earlier one before an observation failure', async () => {
  const stream = heldNativeStream();
  let reads = 0;
  const client = createAgentClient({ env, settleMs: 0, progressMs: 3, streamGraceMs: 25, streamDrainMs: 20,
    continuity: async () => {
      if (++reads > 2) throw new Error('Continuity unavailable');
      return { answer: answer(reads === 1 ? 'Première réponse.' : 'Réponse corrigée.') };
    }, fetchImpl: stream.fetch });
  try {
    assert.equal((await client({ session, text: 'Suite ?' })).text, 'Réponse corrigée.');
    assert.equal(stream.requests(), 1);
  } finally { stream.close(); }
});

test('a stopped watcher cannot restore a ready answer after a newer invalidation', async () => {
  const stream = heldNativeStream();
  let reads = 0, resolveWatcher;
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 1000, progressMs: 3, streamGraceMs: 15, streamDrainMs: 20,
    continuity: async () => {
      reads++;
      if (reads === 1) return { answer: answer('Réponse ancienne.') };
      if (reads === 2) return new Promise(resolve => { resolveWatcher = resolve; });
      if (reads === 3) {
        setTimeout(() => resolveWatcher({ answer: answer('Réponse ancienne.') }), 5);
        return { answer: { status: 'unavailable', runId } };
      }
      throw new Error('Continuity unavailable');
    }, fetchImpl: stream.fetch });
  try {
    await assert.rejects(client({ session, text: 'Suite ?', onDelta: text => deltas.push(text) }), /pas donné de réponse finale/);
    assert.deepEqual(deltas, []);
    assert.equal(stream.requests(), 1);
  } finally { resolveWatcher?.(null); stream.close(); }
});

test('caller cancellation still rejects when a ready answer has already been observed', async () => {
  const abort = new AbortController();
  const stream = heldNativeStream([created, completed]);
  const deltas = [];
  let settled = 0;
  const client = createAgentClient({ env, settleMs: 0, progressMs: 3, streamGraceMs: 30,
    continuity: async () => {
      setTimeout(() => abort.abort(new Error('Caller stopped')), 5);
      return { answer: answer('Ne pas livrer.') };
    }, fetchImpl: stream.fetch });
  try {
    await assert.rejects(client({ session, text: 'Suite ?', signal: abort.signal,
      onDelta: text => deltas.push(text), onSettled: () => { settled++; } }), /Caller stopped/);
    assert.deepEqual(deltas, []);
    assert.equal(stream.requests(), 1);
    assert.equal(settled, 1);
  } finally { stream.close(); }
});

test('a native terminal failure never becomes a cached answer success', async () => {
  let observed, reads = 0;
  const firstRead = new Promise(resolve => { observed = resolve; });
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0, progressMs: 3, streamGraceMs: 30,
    continuity: async () => {
      if (++reads > 1) throw new Error('Continuity unavailable');
      observed();
      return { answer: answer('Ne pas livrer.') };
    }, fetchImpl: async () => ({ ok: true, body: (async function* () {
      yield created;
      await firstRead;
      yield row({ type: 'response.failed', response: { id: runId, error: { message: 'Native failure' } } });
    })() }) });
  await assert.rejects(client({ session, text: 'Suite ?', onDelta: text => deltas.push(text) }), /pas pu finir sa réponse/);
  assert.deepEqual(deltas, []);
});

for (const [name, failed, expected, afterAbort] of [
  ['native failure', row({ type: 'response.failed', response: { id: runId, error: { message: 'Native failure' } } }), /pas pu finir sa réponse/],
  ['native failure after drain abort', row({ type: 'response.failed', response: { id: runId, error: { message: 'Native failure' } } }), /pas pu finir sa réponse/, true],
  ['wrong-run failure', row({ type: 'response.failed', response: { id: 'another-run' } }), /does not match/],
  ['malformed event', Buffer.from('data: {invalid-json}\n\n'), SyntaxError]
]) {
  test(`a late ${name} during drain prevents cached answer delivery`, async () => {
    let reads = 0, startSettlement, releaseFinal;
    const settling = new Promise(resolve => { startSettlement = resolve; });
    const lastRead = new Promise(resolve => { releaseFinal = resolve; });
    const deltas = [];
    const client = createAgentClient({ env, settleMs: 0, progressMs: 3, streamGraceMs: 1, streamDrainMs: afterAbort ? 20 : 1000,
      continuity: async () => {
        if (++reads === 1) return { answer: answer('Ne pas livrer.') };
        startSettlement();
        await lastRead;
        throw new Error('Continuity unavailable');
      }, fetchImpl: async (_url, options) => ({ ok: true, body: (async function* () {
        yield created;
        await settling;
        if (afterAbort) await new Promise(resolve => options.signal.aborted ? resolve()
          : options.signal.addEventListener('abort', resolve, { once: true }));
        try { yield failed; }
        finally { setTimeout(releaseFinal, 10); }
      })() }) });
    await assert.rejects(client({ session, text: 'Suite ?', onDelta: text => deltas.push(text) }), expected);
    assert.deepEqual(deltas, []);
  });
}

test('a parsed native failure prevents cached delivery while iterator closure is still pending', async () => {
  let reads = 0, startSettlement, releaseFinal, finishClosing;
  const settling = new Promise(resolve => { startSettlement = resolve; });
  const lastRead = new Promise(resolve => { releaseFinal = resolve; });
  const closing = new Promise(resolve => { finishClosing = resolve; });
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0, progressMs: 3, streamGraceMs: 1, streamDrainMs: 1000,
    continuity: async () => {
      if (++reads === 1) return { answer: answer('Ne pas livrer.') };
      startSettlement();
      await lastRead;
      throw new Error('Continuity unavailable');
    }, fetchImpl: async () => ({ ok: true, body: (async function* () {
      try {
        yield created;
        await settling;
        yield row({ type: 'response.failed', response: { id: runId, error: { message: 'Native failure' } } });
      } finally {
        releaseFinal();
        await closing;
      }
    })() }) });
  try {
    await assert.rejects(client({ session, text: 'Suite ?', onDelta: text => deltas.push(text) }), /pas pu finir sa réponse/);
    assert.deepEqual(deltas, []);
  } finally { finishClosing(); }
});

for (const finalReadFails of [false, true]) {
  test(`a transport reset during drain preserves ${finalReadFails ? 'retained' : 'fresh'} same-run answer evidence`, async () => {
    let reads = 0, startSettlement, releaseFinal;
    const settling = new Promise(resolve => { startSettlement = resolve; });
    const lastRead = new Promise(resolve => { releaseFinal = resolve; });
    const client = createAgentClient({ env, settleMs: 0, progressMs: 3, streamGraceMs: 1, streamDrainMs: 1000,
      continuity: async () => {
        if (++reads === 1) return { answer: answer('Réponse reçue.') };
        startSettlement();
        await lastRead;
        if (finalReadFails) throw new Error('Continuity unavailable');
        return { answer: answer('Réponse reçue.'), run: { model: 'final-model' } };
      }, fetchImpl: async () => ({ ok: true, body: (async function* () {
        yield created;
        await settling;
        try { throw new Error('Synthetic HTTP reset'); }
        finally { releaseFinal(); }
      })() }) });
    const result = await client({ session, text: 'Suite ?' });
    assert.equal(result.text, 'Réponse reçue.');
    assert.equal(result.metadata.model, finalReadFails ? '' : 'final-model');
  });
}

test('a delegated turn that never settles fails plainly after its bound', async () => {
  const client = createAgentClient({ env, settleMs: 0, delegateMs: 0,
    continuity: async () => ({ run: { model: 'native' }, answer: { status: 'yielded', runId } }),
    fetchImpl: async () => ({ ok: true, body: [created, completed] }) });
  await assert.rejects(client({ session, text: 'Combien ?' }), /autre agent n’a pas répondu/);
});

test('a turn cancelled while the gateway is still preparing settles quickly without native evidence', async () => {
  const abort = new AbortController(); const settled = [];
  const client = createAgentClient({ env, settleMs: 20000, continuity: async () => ({}),
    fetchImpl: async (_url, options) => ({ ok: true, body: (async function* () {
      yield created; abort.abort(); assert.equal(options.signal.aborted, true);
      throw abort.signal.reason;
    })() }) });
  const started = Date.now();
  const result = await client({ session, text: 'Question', signal: abort.signal, onSettled: (...args) => settled.push(args) });
  assert.equal(result.interrupted, true);
  assert.equal(result.tools.status, 'unavailable');
  assert.ok(Date.now() - started < 5000, 'no 20 s wait for an agent_end that never comes');
  assert.deepEqual(settled, [[sessionKeyFor(session), runId]]);
});

test('a turn cancelled after the model started still waits for native termination evidence', async () => {
  const abort = new AbortController();
  const client = createAgentClient({ env, settleMs: 300, continuity: async () => ({}),
    fetchImpl: async () => ({ ok: true, body: (async function* () {
      yield created; yield row({ type: 'response.output_text.delta', delta: 'Bon' }); abort.abort();
      throw abort.signal.reason;
    })() }) });
  await assert.rejects(client({ session, text: 'Question', signal: abort.signal }), /pas encore confirmé/);
});

// The gateway opens its stream with lifecycle rows and an empty message
// scaffold before the agent has produced anything.
const scaffold = [
  row({ type: 'response.in_progress', response: { id: runId } }),
  row({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [], status: 'in_progress' } }),
  row({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
];

test('a cancel during the gateway stream scaffold settles at once, without an agent_end receipt', async () => {
  const abort = new AbortController(); const settled = [];
  const client = createAgentClient({ env, settleMs: 20000, continuity: async () => ({}),
    fetchImpl: async () => ({ ok: true, body: (async function* () {
      yield created; for (const item of scaffold) yield item;
      abort.abort(); throw abort.signal.reason;
    })() }) });
  const started = Date.now();
  const result = await client({ session, text: 'Question', signal: abort.signal, onSettled: (...args) => settled.push(args) });
  assert.equal(result.interrupted, true);
  assert.ok(Date.now() - started < 5000, 'no 20 s wait for an agent_end that never comes');
  assert.deepEqual(settled, [[sessionKeyFor(session), runId]]);
});

for (const [label, started] of [
  ['a tool call item', row({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', name: 'tool_search', call_id: 'call_1' } })],
  ['a reasoning item', row({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } })],
  ['a text delta after the scaffold', row({ type: 'response.output_text.delta', delta: 'Bon' })]
]) {
  test(`a cancel after ${label} keeps waiting for native termination evidence`, async () => {
    const abort = new AbortController(); const settled = [];
    const client = createAgentClient({ env, settleMs: 300, continuity: async () => ({}),
      fetchImpl: async () => ({ ok: true, body: (async function* () {
        yield created; for (const item of scaffold) yield item; yield started;
        abort.abort(); throw abort.signal.reason;
      })() }) });
    await assert.rejects(client({ session, text: 'Question', signal: abort.signal, onSettled: (...args) => settled.push(args) }),
      /L’arrêt de Nestor n’est pas encore confirmé/);
    assert.deepEqual(settled, [], 'an unconfirmed stop never releases the turn');
  });
}


// The gateway can announce completion without closing HTTP. The test guard
// only releases the fixture on the old path; it must never be the client bound.
for (const browser of [false, true]) {
  test(`a confirmed completion bounds an open body with unavailable evidence (${browser ? 'GraphysX' : 'Nestor'})`, async () => {
    const guard = new AbortController();
    let closeStream, requests = 0, settled = 0;
    const deltas = [];
    const client = createAgentClient({ env, settleMs: 0, progressMs: 5, streamGraceMs: 10, streamDrainMs: 30,
      continuity: async () => { throw new Error('Evidence unavailable'); },
      fetchImpl: async (_url, options) => {
        requests++;
        options.signal.addEventListener('abort', () => closeStream?.(), { once: true });
        return { ok: true, body: (async function* () {
          yield created;
          yield browser ? browserCompleted([browserItem({ reply: 'Bonjour.' })]) : completed;
          await new Promise(resolve => { closeStream = resolve; });
          options.signal.throwIfAborted();
        })() };
      } });
    const timeout = setTimeout(() => guard.abort(new Error('Test deadline reached')), 250);
    try {
      const turn = client({ session, text: 'Alors ?', signal: guard.signal,
        ...(browser ? { browserReply: { context: browserContext } } : {}),
        onDelta: text => deltas.push(text), onSettled: () => { settled++; } });
      if (browser) {
        const result = await turn;
        assert.equal(result.text, 'Bonjour.');
        assert.equal(result.tools.status, 'unavailable');
        assert.equal(result.tools.browserReply.callId, 'call_scene_1');
        assert.deepEqual(deltas, ['Bonjour.']);
      } else {
        await assert.rejects(turn, /Nestor n’a pas donné de réponse finale/);
        assert.deepEqual(deltas, []);
      }
      assert.equal(guard.signal.aborted, false, 'the test guard must not finish the turn');
      assert.equal(settled, 1);
      assert.equal(requests, 1, 'observation never replays the native request');
      await new Promise(resolve => setTimeout(resolve, 45));
      assert.equal(settled, 1, 'drain does not settle the turn again');
      assert.equal(deltas.length, browser ? 1 : 0, 'drain never delivers a second answer');
    } finally { clearTimeout(timeout); closeStream?.(); }
  });
}


test('caller interruption during completion grace never delivers the browser action', async () => {
  const caller = new AbortController();
  let closeStream, settled = 0;
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0, progressMs: 5, streamGraceMs: 50,
    continuity: async () => { throw new Error('Evidence unavailable'); },
    fetchImpl: async (_url, options) => {
      options.signal.addEventListener('abort', () => closeStream?.(), { once: true });
      return { ok: true, body: (async function* () {
        yield created;
        yield browserCompleted([browserItem({ reply: 'Bonjour.' })]);
        await new Promise(resolve => { closeStream = resolve; setTimeout(() => caller.abort(), 5); });
        options.signal.throwIfAborted();
      })() };
    } });
  await assert.rejects(client({ session, text: 'Alors ?', signal: caller.signal,
    browserReply: { context: browserContext }, onDelta: text => deltas.push(text), onSettled: () => { settled++; } }),
  error => error.name === 'AbortError');
  assert.deepEqual(deltas, []);
  assert.equal(settled, 1, 'the completion already confirmed native termination');
});

test('GraphysX dialogue delivers verified same-run text after completion with open HTTP', async () => {
  let release, settled = 0;
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0, progressMs: 25, streamGraceMs: 5, streamDrainMs: 20,
    continuity: async () => ({ run: { model: 'native' }, answer: answer('Bonjour.') }),
    fetchImpl: async (_url, options) => ({ ok: true, body: (async function* () {
      yield created;
      yield browserCompleted([]);
      await new Promise(resolve => {
        release = resolve;
        options.signal.addEventListener('abort', resolve, { once: true });
      });
    })() }) });
  try {
    const result = await client({ session, text: 'Salut', browserReply: { context: browserContext },
      onDelta: text => deltas.push(text), onSettled: () => { settled++; } });
    assert.equal(result.text, 'Bonjour.');
    assert.equal(result.tools.browserReply, undefined);
    assert.equal(typeof result.metadata.phases.streamOverdue, 'number');
    assert.equal(result.metadata.phases.streamEnd, undefined);
    assert.deepEqual(deltas, ['Bonjour.']);
    assert.equal(settled, 1);
  } finally { release?.(); }
});
