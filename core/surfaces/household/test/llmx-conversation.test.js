'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const llmx = require('../llmx-conversation');
const { createConversationExecutor } = require('../conversation-executor');

test('world v2 exposes scenery, native catalogs and full commands without replacing the session boundary', () => {
  const context = { schemaVersion: 1, environment: { id: 'forge', name: 'Forge' }, revision: 'now',
    capabilities: { commandsVersion: 2, mathVersion: 1 }, buildZone: { center: [5, 0, 5], radius: 4 },
    entities: Array.from({ length: 64 }, (_, index) => ({ id: 'floor-' + index, type: 'box' })),
    world: { details: [], settings: { sky: 'clearnight' }, catalogs: { textures: ['wood-floor'] }, joints: [] } };
  assert.deepEqual(llmx.sceneContext(context), context);
  const commands = [{ op: 'update', id: 'floor-0', patch: { transform: { position: [100, 2, 0] } } },
    { op: 'set-environment', environment: { sky: 'clearblue' } },
    { op: 'attach-behavior', id: 'floor-1', behavior: { id: 'spin', type: 'spin', speedDegrees: 20 } },
    { op: 'add-joint', joint: { id: 'rope', type: 'rope', bodyA: 'floor-2', bodyB: 'floor-3', length: 4 } },
    { op: 'interact', id: 'ball', interactionId: 'push' }];
  const result = llmx.sceneReply(JSON.stringify({ reply: 'Je vais transformer le décor.', scene: { schemaVersion: 1, intent: 'Transformer le monde', commands } }), context);
  assert.deepEqual(result.sceneProposal.commands, commands);
  assert.equal(result.sceneProposal.environmentId, 'forge'); assert.equal(result.sceneProposal.revision, 'now');
  const prompt = llmx.scenePrompt(context);
  assert.match(prompt, /tool_search cannot discover or operate the active browser world/);
  assert.match(prompt, /Compose the final scene JSON directly/);
  assert.match(prompt, /Other native agent tools remain available/);
  assert.match(prompt, /NEVER a spatial restriction/); assert.match(prompt, /update.path/);
  assert.match(prompt, /Behaviors are flat objects/);
  assert.match(prompt, /type:"follow-spline",splineId:"path-1",speed:1,loop:true,orientToPath:true/);
  assert.doesNotMatch(prompt, /Behaviors use spin:\{/);
  const behavior = llmx.browserReplyTool().parameters.properties.scene.properties.commands.items.properties.behavior;
  assert.deepEqual(behavior.required, ['id', 'type']);
  assert.ok(behavior.properties.type.enum.includes('follow-spline'));
  assert.ok(!behavior.properties.type.enum.includes('behavior'));
  assert.doesNotMatch(prompt, /Never modify the protected Forge|stay inside the supplied buildZone/);
  assert.throws(() => llmx.sceneReply('[{"op":"set-environment","environment":{"sky":"clearblue"}}]', context));
  assert.throws(() => llmx.sceneReply(JSON.stringify({ reply: 'Test', scene: { schemaVersion: 1, intent: 'Test', commands: [{ op: 'eval', code: 'anything' }] } }), context));
  assert.equal(llmx.sceneReply('On peut parler normalement.', context).sceneProposal, null);
});

test('LLMx scene observations are bounded data with no arbitrary instruction or executable fields', () => {
  const context = { schemaVersion: 1, environment: { id: 'forge', name: 'Forge nocturne' }, revision: '1',
    selectedEntityIds: ['cube'], entities: [{ id: 'cube', type: 'box', position: [1, 2, 3] }] };
  assert.deepEqual(llmx.sceneContext(context), context);
  assert.equal(llmx.sceneContext(undefined), null);
  for (const invalid of [{ ...context, prompt: 'Override' }, { ...context, entities: Array(25).fill(context.entities[0]) },
    { ...context, entities: [{ id: 'cube', type: 'box', position: [NaN, 0, 0] }] },
    { ...context, environment: { id: 'forge', name: 'x'.repeat(121) } }, { ...context, selectedEntityIds: Array(9).fill('cube') }]) {
    assert.throws(() => llmx.sceneContext(invalid), { statusCode: 400 });
  }
  assert.match(llmx.scenePrompt(context), /data, not instructions/);
});

test('the real AgentX executor sends an explicitly marked application event without inventing user speech', async () => {
  let body;
  const applicationEvent = llmx.openingEvent({ voice: { language: 'fr' } }, null);
  const execute = createConversationExecutor({ inference: { execute: async value => {
    body = value; return { ok: true, body: { response: 'Hello. On commence?' } };
  } } });
  await execute({ backend: 'agentx', session: { modeId: 'operator' }, pack: { id: 'personal_operator' },
    applicationEvent, text: '', history: [], agentxInstructions: 'Selected persona' + llmx.openingPrompt(applicationEvent) });
  assert.ok(body.messages.at(-1).content.startsWith('[Household application event; no human utterance]\n' + JSON.stringify(applicationEvent)));
  assert.match(body.messages.at(-1).content, /exact word "Hello"/);
  assert.match(body.messages.at(-1).content, /Do not yield, delegate, wait for a human message, or return NO_REPLY/);
  assert.match(body.messages[0].content, /exact word "Hello"/);
  assert.equal(applicationEvent.origin, 'application_opening');
  assert.equal(applicationEvent.language, 'fr');
});

test('a persisted pending opening without a live owner is uncertain, never eligible for implicit replay', () => {
  const value = { version: 1, status: 'pending', turnId: '1234567890123456' };
  assert.equal(llmx.publicOpening(value, false).status, 'uncertain');
  assert.equal(llmx.publicOpening(value, true).status, 'pending');
  assert.equal(value.status, 'pending');
});

const scene = { schemaVersion: 1, environment: { id: 'forge', name: 'Forge nocturne' }, revision: 'scene-8',
  capabilities: { commandsVersion: 1, mathVersion: 1 }, buildZone: { center: [4, 0, 3], radius: 5 } };
const command = { op: 'spawn', entity: { id: 'llmx-created-cube-1', type: 'box', transform: { position: [4, 1, 3] } } };
const response = { reply: 'Je vais ajouter un cube.', scene: { schemaVersion: 1,
  environmentId: 'forge', revision: 'scene-8', intent: 'Créer un cube', commands: [command] } };

test('native browser replies preserve dialogue and return only the persisted outcome, never assumed success', () => {
  assert.deepEqual(llmx.sceneReply('{"reply":"Bonjour."}', scene), { text: 'Bonjour.', sceneProposal: null });
  assert.match(llmx.scenePrompt(scene, { clientTool: true }), /For scene changes, finish by calling the available graphysx_reply client tool exactly once/);
  assert.match(llmx.scenePrompt(scene, { clientTool: true }), /For ordinary dialogue, answer naturally as in the existing conversation/);
  assert.doesNotMatch(llmx.scenePrompt(scene, { clientTool: true }), /ENTIRE final answer|Complete final answer example|ordinary dialogue must remain plain natural text/i);
  assert.doesNotMatch(llmx.scenePrompt(scene, { opening: true, clientTool: true }), /graphysx_reply/);
  const opening = llmx.scenePrompt({ ...scene, entities: [{ id: 'large-room', type: 'box' }], world: { catalogs: {} } }, { opening: true });
  assert.deepEqual(JSON.parse(opening.split('\n').at(-1)), { schemaVersion: 1, environment: scene.environment });
  const finished = { ...scene, mathLesson: { operation: 'add', left: 1, right: 1, step: 1, result: 2 } };
  assert.doesNotMatch(llmx.scenePrompt(finished, { clientTool: true }), /plain natural text/);
  const base = { clientTurnId: 'human-turn', toolEvidence: { browserReply: {
    callId: 'call_1', runId: 'resp_22222222-2222-4222-8222-222222222222' } } };
  assert.equal(llmx.browserReplyOutput(null), null);
  assert.equal(JSON.parse(llmx.browserReplyOutput(base).output).status, 'reply_delivered');
  assert.equal(JSON.parse(llmx.browserReplyOutput({ ...base, sceneProposal: response.scene }).output).status, 'unconfirmed');
  const rejected = { status: 'rejected', message: 'World changed', entityIds: [] };
  const result = llmx.browserReplyOutput({ ...base, sceneProposal: response.scene, sceneReceipt: rejected });
  assert.equal(JSON.parse(result.output).status, 'rejected'); assert.deepEqual(JSON.parse(result.output).receipt, rejected);
});

test('LLMx scene capabilities require the current build zone and revision, with bounded client receipts', () => {
  const receipt = { turnId: '1234567890123456', status: 'applied', entityIds: ['llmx-created-cube-1'], message: 'Cube créé.' };
  assert.deepEqual(llmx.sceneContext({ ...scene, lastAction: receipt }), { ...scene, lastAction: receipt });
  const many = { ...receipt, entityIds: Array.from({ length: 256 }, (_, i) => `llmx-created-math-${i}`) };
  assert.equal(llmx.sceneReceipt(many).entityIds.length, 256);
  const lesson = { operation: 'add', left: 2, right: 3, step: 2, result: 5 };
  assert.deepEqual(llmx.sceneContext({ ...scene, mathLesson: lesson }).mathLesson, lesson);
  for (const value of [{ ...scene, revision: undefined }, { ...scene, buildZone: undefined },
    { ...scene, buildZone: { center: [0, Infinity, 0], radius: 1 } }, { ...scene, buildZone: { center: [0, 0, 0], radius: 0 } },
    { ...scene, capabilities: { commandsVersion: 3 } }, { ...scene, capabilities: { commandsVersion: 1, execute: true } },
    { ...scene, mathLesson: { ...lesson, result: 6 } }, { ...scene, mathLesson: { ...lesson, step: 4 } },
    { ...scene, mathLesson: { ...lesson, step: undefined } }]) {
    assert.throws(() => llmx.sceneContext(value), { statusCode: 400 });
  }
  for (const value of [{ ...receipt, status: 'queued' }, { ...receipt, turnId: 'short' }, { ...receipt, message: 'x'.repeat(401) },
    { ...receipt, entityIds: ['same', 'same'] }, { ...many, entityIds: [...many.entityIds, 'extra'] }]) {
    assert.throws(() => llmx.sceneReceipt(value), { statusCode: 400 });
  }
});

test('LLMx extracts only a whole supported scene envelope, never commands quoted or embedded in dialogue', () => {
  for (const value of [JSON.stringify(response), '```json\n' + JSON.stringify(response) + '\n```']) {
    assert.deepEqual(llmx.sceneReply(value, scene), { text: response.reply, sceneProposal: response.scene });
  }
  for (const value of ['Bonjour. On peut compter ensemble.', `Voici un exemple : ${JSON.stringify(response)}`,
    JSON.stringify(JSON.stringify(response)), '```json\n' + JSON.stringify(response) + '\n```\nUn exemple seulement.', '{"sample":"ordinary data"}',
    `La commande ressemble à \`${JSON.stringify(command)}\`, sans l’exécuter.`,
    `Voici un exemple :\n\`\`\`json\n${JSON.stringify([command])}\n\`\`\``,
    `Exemple cité :\n> ${JSON.stringify([command])}`, JSON.stringify(JSON.stringify([command])),
    'La réponse contient {"reply":"bonjour"}.', 'Le calcul contient {"op":"sum"}.',
    'Voici les données : {"math":{"operation":"multiply","left":2,"right":3}}.',
    'La scène du récit : {"scene":"une forêt"}.',
    'On peut utiliser les mots commands, math, scene et reply pour expliquer le format.']) {
    assert.deepEqual(llmx.sceneReply(value, scene), { text: value, sceneProposal: null });
  }
  assert.match(llmx.scenePrompt(scene), /ENTIRE final answer/);
  assert.match(llmx.scenePrompt(scene, { opening: true }), /No scene mutation tools are available/);
  assert.doesNotMatch(llmx.scenePrompt(scene, { opening: true }), /Native examples/);
});

test('LLMx prompt provides complete parseable cube and math envelopes for the actual observation', () => {
  const context = { ...scene, environment: { id: 'family-atelier-2', name: 'Notre atelier' }, revision: 'revision-42',
    buildZone: { center: [-8, 2, 11], radius: 0.4 } };
  const prompt = llmx.scenePrompt(context);
  const exampleLines = prompt.split('\n').filter(line => line.startsWith('{"reply":'));
  const examples = exampleLines.map(line => llmx.sceneReply(line, context));
  assert.equal(examples.length, 3);
  for (const line of exampleLines) assert.doesNotMatch(line, /environmentId|revision/);
  for (const example of examples) {
    assert.equal(example.sceneProposal.environmentId, context.environment.id);
    assert.equal(example.sceneProposal.revision, context.revision);
  }
  const cube = examples[0].sceneProposal.commands[0].entity;
  const position = cube.transform.position;
  const halfSize = cube.transform.scale[0] / 2;
  for (const x of [-halfSize, halfSize]) for (const y of [-halfSize, halfSize]) for (const z of [-halfSize, halfSize]) {
    assert.ok(Math.hypot(position[0] + x + 8, position[1] + y - 2, position[2] + z - 11) < context.buildZone.radius);
  }
  assert.deepEqual(examples[2].sceneProposal.math, { operation: 'add', left: 2, right: 3, step: 0 });
  assert.match(prompt, /overrides the earlier presentation instruction/);
  assert.doesNotMatch(prompt, /Native examples|native commands\]|integer0|the current environment id/);
  assert.equal(llmx.scenePrompt({ ...context, capabilities: { commandsVersion: 1 } }).split('\n')
    .filter(line => line.startsWith('{"reply":')).length, 2);
  assert.doesNotMatch(llmx.scenePrompt(context, { opening: true }), /"reply":|presentation instruction/);
});

test('LLMx placement examples use real box extents and stack their bases on the observed floor', () => {
  const boxBounds = entity => {
    const p = entity.transform.position, scale = entity.transform.scale ?? [1, 1, 1];
    const size = ['width', 'height', 'depth'].map((key, i) => (entity.geometry?.[key] ?? 1) * scale[i]);
    return { min: p.map((n, i) => n - size[i] / 2), max: p.map((n, i) => n + size[i] / 2) };
  };
  for (const zone of [{ center: [4.6, 0.18, 3.4], radius: 2.6 }, { center: [-8, 2, 11], radius: 0.4 }]) {
    const context = { ...scene, buildZone: zone };
    const prompt = llmx.scenePrompt(context);
    const facts = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"floorY":')));
    assert.equal(facts.floorY, zone.center[1]);
    assert.deepEqual(facts.defaultBoxGeometry, { width: 1, height: 1, depth: 1 });
    assert.deepEqual(facts.defaultScale, [1, 1, 1]);
    const proposals = prompt.split('\n').filter(line => line.startsWith('{"reply":')).map(line => llmx.sceneReply(line, context).sceneProposal);
    const pyramid = proposals.find(proposal => proposal.commands?.length === 3);
    const bounds = pyramid.commands.map(command => boxBounds(command.entity));
    for (const proposal of proposals.filter(proposal => proposal.commands)) for (const command of proposal.commands) {
      const box = boxBounds(command.entity);
      for (let i = 0; i < 3; i++) {
        assert.ok(box.min[i] >= facts.allowedBounds.min[i] - 1e-8);
        assert.ok(box.max[i] <= facts.allowedBounds.max[i] + 1e-8);
      }
    }
    assert.ok(Math.abs(bounds[0].min[1] - facts.floorY) < 1e-8);
    assert.ok(Math.abs(bounds[1].min[1] - facts.floorY) < 1e-8);
    assert.ok(Math.abs(bounds[0].max[0] - bounds[1].min[0]) < 1e-8, 'The two base boxes touch without overlapping');
    assert.ok(Math.abs(bounds[2].min[1] - bounds[0].max[1]) < 1e-8, 'The top box rests on the bases');
    assert.ok(Math.abs(bounds[2].max[1] - facts.floorY - 2 * (bounds[0].max[1] - bounds[0].min[1])) < 1e-8);
    // The witnessed response omitted scale and used y=.315 as if its unit cube
    // were a small block resting on y=0. Native defaults put it below the floor.
    const witnessed = { transform: { position: [4.2, 0.315, 3] } };
    if (zone.center[1] === 0.18) {
      const original = boxBounds(witnessed);
      assert.equal(original.min[1], -0.185);
      assert.ok(original.min[1] < facts.allowedBounds.min[1]);
      const placed = boxBounds({ transform: { position: [4.2, facts.floorY + 0.5, 3] } });
      assert.ok(Math.abs(placed.min[1] - facts.floorY) < 1e-8);
    }
  }
});

test('LLMx edit examples use exact native command shapes and an existing non-math observation id', () => {
  const protectedEntities = [{ id: 'llmx-face', type: 'box' }, { id: 'llmx-created-math', type: 'group' },
    { id: 'llmx-created-math-unit-1', type: 'box' }, { id: 'llmx-created-invalid id', type: 'box' }];
  const examples = context => llmx.scenePrompt(context).split('\n').filter(line => line.startsWith('{"reply":'))
    .map(line => llmx.sceneReply(line, context).sceneProposal).filter(proposal => proposal.commands);
  for (const id of ['llmx-created-pyramid-base-1', 'llmx-created-another-box']) {
    const context = { ...scene, entities: [...protectedEntities, { id, type: 'box' }] };
    const proposals = examples(context);
    const update = proposals.find(proposal => proposal.commands[0].op === 'update');
    assert.deepEqual(update.commands, [{ op: 'update', id, patch: { material: { color: '#b87333' } } }]);
    const remove = proposals.find(proposal => proposal.commands[0].op === 'remove');
    assert.deepEqual(remove.commands, [{ op: 'remove', id }]);
    assert.ok(proposals.filter(proposal => proposal.commands[0].op === 'spawn').every(proposal => proposal.commands.every(command => command.entity.id)));
    assert.doesNotMatch(llmx.scenePrompt(context), /Never modify the Forge, face or authored objects/);
    assert.equal(llmx.scenePrompt(context, { opening: true }).includes('"op":"update"'), false);
  }
  assert.ok(examples({ ...scene, entities: protectedEntities }).every(proposal => proposal.commands.every(command => command.op === 'spawn')));
});

test('LLMx rejects the witnessed update entity wrapper without guessing an id or converting it into a patch', () => {
  const commands = ['llmx-created-pyramid-base-1', 'llmx-created-pyramid-base-2', 'llmx-created-pyramid-top']
    .map(id => ({ op: 'update', entity: { id, material: { color: '#b87333' } } }));
  const witnessed = { reply: 'Je vais colorer la pyramide de trois boîtes en cuivre.', scene: { schemaVersion: 1,
    intent: 'Colorer la pyramide de trois boîtes en cuivre', commands } };
  const before = JSON.stringify(witnessed);
  for (const value of [before, '```json\n' + before + '\n```']) {
    assert.throws(() => llmx.sceneReply(value, scene), { code: 'LLMX_SCENE_INVALID' });
  }
  assert.equal(JSON.stringify(witnessed), before);
  const valid = { ...witnessed, scene: { ...witnessed.scene, commands: commands.map(command => ({
    op: 'update', id: command.entity.id, patch: { material: { color: '#b87333' } } })) } };
  assert.deepEqual(llmx.sceneReply(JSON.stringify(valid), scene).sceneProposal.commands, valid.scene.commands);
});

test('LLMx rejects native and math output outside the required envelope, including partial arrays', () => {
  for (const value of [JSON.stringify([command]), JSON.stringify(command), JSON.stringify({ commands: [command] }),
    `Je vais créer un cube.\n\n${JSON.stringify([command], null, 2)}`, `Je vais créer un cube. ${JSON.stringify(command)}`,
    'Je vais créer un cube.\n[{"op":"spawn",', '```json\n[{"op":"spawn","entity":',
    `Je vais créer un cube.\n\`\`\`json\n${JSON.stringify([command])}\n\`\`\``,
    'Je vais montrer deux plus trois.\n[{"math":{"operation":"add","left":2,"right":3}}]',
    '[{"math":{"operation":"add",', '{"math":{"operation":"add","left":2,"right":3}}',
    'Je vais avancer. [{"math":{"action":"next"}}]',
    'Je vais créer un cube.\n{"reply":"Je vais créer un cube.","scene":{"schemaVersion":1,']) {
    assert.throws(() => llmx.sceneReply(value, scene), error => error.statusCode === 502 && error.code === 'LLMX_SCENE_INVALID'
      && /Aucun objet n’a été modifié/.test(error.message), value);
  }
});

test('LLMx rejects incomplete, oversized or unsupported envelopes without extracting a partial action', () => {
  for (const value of [JSON.stringify(response).slice(0, -1), '```json\n' + JSON.stringify(response).slice(0, -1),
    '```JSON\n' + JSON.stringify(response), '{"rep', JSON.stringify({ ...response, extra: true }),
    JSON.stringify({ ...response, reply: '' }), JSON.stringify({ ...response, scene: { ...response.scene, schemaVersion: 2 } }),
    JSON.stringify({ ...response, scene: { ...response.scene, commands: [] } }),
    JSON.stringify({ ...response, scene: { ...response.scene, commands: Array(41).fill(command) } }),
    JSON.stringify({ ...response, scene: { ...response.scene, commands: [{ op: 'script', id: command.entity.id }] } }),
    JSON.stringify({ ...response, scene: { ...response.scene, commands: [{ op: 'remove', id: 'llmx-face' }] } }),
    JSON.stringify({ ...response, scene: { ...response.scene, commands: [{ ...command, payload: 'x'.repeat(65536) }] } })]) {
    assert.throws(() => llmx.sceneReply(value, scene), { statusCode: 502, code: 'LLMX_SCENE_INVALID' });
  }
  assert.throws(() => llmx.sceneReply(JSON.stringify(response), { ...scene, capabilities: undefined }), { code: 'LLMX_SCENE_INVALID' });
});

test('LLMx binds scene scope to this request and treats legacy model scope as bounded non-authoritative data', () => {
  const proposal = { ...response.scene }; delete proposal.environmentId; delete proposal.revision;
  for (const metadata of [{}, { environmentId: 'old-room' }, { revision: '0:11' }, { environmentId: 'old-room', revision: '0:11' }]) {
    const envelope = JSON.stringify({ ...response, scene: { ...proposal, ...metadata } });
    for (const value of [envelope, '```json\n' + envelope + '\n```']) {
      assert.deepEqual(llmx.sceneReply(value, scene).sceneProposal, response.scene);
    }
  }
  for (const key of ['environmentId', 'revision']) for (const value of [null, 12, {}, [], '', 'x'.repeat(81), 'old\nroom']) {
    assert.throws(() => llmx.sceneReply(JSON.stringify({ ...response, scene: { ...proposal, [key]: value } }), scene),
      { code: 'LLMX_SCENE_INVALID' });
  }
});

test('LLMx next math action advances exactly once from the current validated observation', () => {
  const next = { reply: 'Je vais avancer.', scene: { schemaVersion: 1, intent: 'Étape suivante', math: { action: 'next' } } };
  for (const lesson of [{ operation: 'add', left: 2, right: 3, step: 1, result: 5 },
    { operation: 'subtract', left: 5, right: 2, step: 0, result: 3 },
    { operation: 'count', left: 20, right: 0, step: 19, result: 20 }]) {
    const context = { ...scene, mathLesson: lesson };
    const actual = llmx.sceneReply(JSON.stringify(next), context).sceneProposal.math;
    assert.deepEqual(actual, { operation: lesson.operation, left: lesson.left, right: lesson.right, step: lesson.step + 1 });
    const prompt = llmx.scenePrompt(context, { lastProposal: { revision: 'old', receipt: { message: 'Étape 0.' } } });
    const example = prompt.split('\n').filter(line => line.startsWith('{"reply":')).map(JSON.parse).find(value => value.scene.math);
    assert.deepEqual(example.scene.math, { action: 'next' });
    assert.match(prompt, /overrides ALL historical proposals and receipts/);
    assert.match(prompt, /NEW exercise, use the operation and operands requested by the user/);
    assert.doesNotMatch(prompt, /"operation":"add","left":2,"right":3,"step":0/);
  }
  for (const lesson of [undefined, { operation: 'count', left: 0, right: 0, step: 0, result: 0 },
    { operation: 'count', left: 20, right: 0, step: 20, result: 20 },
    { operation: 'add', left: 2, right: 3, step: 3, result: 5 },
    { operation: 'subtract', left: 5, right: 0, step: 0, result: 5 },
    { operation: 'add', left: 2, right: 3, step: 1, result: 6 }]) {
    assert.throws(() => llmx.sceneReply(JSON.stringify(next), { ...scene, mathLesson: lesson }), { code: 'LLMX_SCENE_INVALID' });
  }
  const complete = { ...scene, mathLesson: { operation: 'count', left: 1, right: 0, step: 1, result: 1 } };
  assert.match(llmx.scenePrompt(complete), /current mathLesson is complete/);
  assert.doesNotMatch(llmx.scenePrompt(complete), /"action":"next"/);
  for (const math of [{ action: 'previous' }, { action: 'next', step: 2 }, { action: 'next', operation: 'add', left: 2, right: 3 }]) {
    assert.throws(() => llmx.sceneReply(JSON.stringify({ ...next, scene: { ...next.scene, math } }),
      { ...scene, mathLesson: { operation: 'add', left: 2, right: 3, step: 1, result: 5 } }), { code: 'LLMX_SCENE_INVALID' });
  }
  const newMath = { operation: 'subtract', left: 7, right: 3, step: 0 };
  assert.deepEqual(llmx.sceneReply(JSON.stringify({ ...next, scene: { ...next.scene, math: newMath } }), complete).sceneProposal.math, newMath);
});

test('LLMx early math is mutually exclusive with commands and obeys the arithmetic domain', () => {
  const proposal = { ...response.scene }; delete proposal.commands;
  const parse = math => llmx.sceneReply(JSON.stringify({ ...response, scene: { ...proposal, math } }), scene);
  for (const math of [{ operation: 'count', left: 20, right: 0 }, { operation: 'add', left: 2, right: 3, step: 0 },
    { operation: 'subtract', left: 5, right: 2 }]) assert.deepEqual(parse(math).sceneProposal.math, math);
  for (const math of [{ operation: 'count', left: 2, right: 1 }, { operation: 'add', left: 20, right: 1 },
    { operation: 'subtract', left: 2, right: 3 }, { operation: 'multiply', left: 2, right: 3 },
    { operation: 'add', left: 0.5, right: 1 }, { operation: 'count', left: -1, right: 0 },
    { operation: 'count', left: 1, right: 0, step: -1 }]) assert.throws(() => parse(math), { code: 'LLMX_SCENE_INVALID' });
  assert.throws(() => llmx.sceneReply(JSON.stringify({ ...response,
    scene: { ...response.scene, math: { operation: 'count', left: 1, right: 0 } } }), scene), { code: 'LLMX_SCENE_INVALID' });
});
