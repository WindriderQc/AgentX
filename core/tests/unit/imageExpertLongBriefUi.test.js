'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const contract = require('../../public/js/image-brief-constraints');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/image-expert.js'), 'utf8');
const manifest = { version: 1, items: [{ id: 'title', kind: 'exact-text', text: 'EXACT TITLE' }] };
const sessionId = '11111111-1111-4111-8111-111111111111';
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 10; }
  get options() { return this.children; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatchEvent(event) { return Promise.all((this.listeners[event.type] || []).map(handler => handler(event))); }
  focus() {}
}
const settle = async () => { for (let count = 0; count < 80; count++) await Promise.resolve(); };
async function expert({ prompt = 'x'.repeat(9958), constraints = manifest, available = true, sessionPending } = {}) {
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const current = { ready: true, locked: false, prompt, profile: 'quality', width: 1024, height: 576, referenceCount: 1, referenceEpoch: 1, seed: '73', constraints };
  const getContext = () => {
    let constraintsInvalid = false;
    try { if (current.prompt.length > contract.MAX_BRIEF) throw Error(); contract.composeBrief(current.prompt, current.constraints); } catch { constraintsInvalid = true; }
    return { ...current, constraintsInvalid };
  };
  const posts = [], sessions = [], turns = [], apply = jest.fn((text, receipt) => { current.prompt = text; current.receipt = receipt; });
  let next = 0;
  const fetch = jest.fn(async (url, options) => {
    const body = options.method === 'POST' ? JSON.parse(options.body) : null;
    if (body) posts.push({ url, body });
    let data;
    if (url.endsWith('/status')) data = { available, resources: [], routing: {} };
    else if (url.endsWith('/sessions') && body) {
      if (sessionPending) await sessionPending;
      const session = { sessionId, label: 'Fixture', createdAt: '2026-01-01T00:00:00Z' }; sessions.push(session); data = { session };
    } else if (url.endsWith('/sessions')) data = { sessions };
    else if (url.endsWith('/turns') && body) {
      const visualPrompt = 'A condensed scene, retaining the complete intent.';
      const turn = { id: body.clientTurnId, input: body.message, context: body.context, state: 'completed', events: [], envelope: {},
        proposal: { visualPrompt, prompt: contract.compose(visualPrompt, body.context.constraints), constraints: body.context.constraints,
          profile: body.context.profile, width: body.context.width, height: body.context.height } };
      turns.push(turn); data = { turn };
    } else if (url.endsWith('/turns')) data = { turns };
    else throw new Error(`Unexpected fixture endpoint: ${url}`);
    return { ok: true, json: async () => ({ ok: true, ...data }) };
  });
  const context = vm.createContext({ document: { getElementById: get, createElement: tag => new Element(tag) }, fetch,
    ImageBriefConstraints: contract, Intl, Date, URLSearchParams, location: { search: '' },
    localStorage: { getItem() {}, setItem() {}, removeItem() {} }, crypto: { randomUUID: () => `turn-${++next}` },
    setTimeout: jest.fn(), clearTimeout() {} });
  vm.runInContext(source, context);
  const controller = context.AgentXImageExpert.mount({ getContext, apply }); await settle();
  const fire = async (id, type = 'click') => { await get(id).dispatchEvent({ type, preventDefault() {} }); await settle(); };
  return { get, fire, current, getContext, controller, posts, turns, apply };
}

test('planning retains a 9958-character brief with exact constraints and allows applying an 8000-budget proposal', async () => {
  const ui = await expert(), original = ui.current.prompt;
  expect(ui.get('imagex-plan').disabled).toBe(false);
  expect(ui.get('imagex-planning-help').textContent).toContain('brief long reste conservé');
  await ui.fire('imagex-plan');
  expect(ui.posts).toHaveLength(2);
  expect(ui.posts[1].body).toMatchObject({ mode: 'plan', context: { prompt: original, constraints: manifest, referenceCount: 1 } });
  expect(ui.get('imagex-proposal-original').textContent).toBe(original);
  expect(ui.get('imagex-apply').disabled).toBe(false);
  await ui.fire('imagex-apply');
  expect(ui.apply).toHaveBeenCalledWith('A condensed scene, retaining the complete intent.', { sessionId, turnId: 'turn-1' });
  expect(ui.current.seed).toBe('73'); expect(ui.current.referenceEpoch).toBe(1);
});
test.each([{ label: 'text', prompt: 'x'.repeat(32001) }, { label: 'whitespace', prompt: ' '.repeat(32001) }])('an over-budget $label brief remains intact and refuses before creating a session', async ({ prompt }) => {
  const ui = await expert({ prompt, constraints: undefined });
  expect(ui.get('imagex-plan').disabled).toBe(true);
  await ui.fire('imagex-plan');
  expect(ui.posts).toHaveLength(0); expect(ui.current.prompt).toBe(prompt);
  expect(ui.get('imagex-notice').textContent).toContain('32 000');
});
test('a valid raw brief whose exact constraint block exceeds the planning budget is refused', async () => {
  const ui = await expert({ prompt: 'x'.repeat(31990) });
  await ui.fire('imagex-plan'); expect(ui.posts).toHaveLength(0);
  expect(ui.get('imagex-notice').textContent).toContain('32 000');
});
test.each([{ label: 'text', message: 'x'.repeat(32001) }, { label: 'whitespace', message: ' '.repeat(32001) }])('an over-budget $label message remains intact and blocks all consultation entry points', async ({ message }) => {
  const ui = await expert(); ui.get('imagex-message').value = message; await ui.fire('imagex-message', 'input');
  expect(ui.get('imagex-plan').disabled).toBe(true); expect(ui.get('imagex-send').disabled).toBe(true);
  await ui.fire('imagex-plan'); await ui.fire('imagex-explore'); await ui.fire('imagex-chat-form', 'submit');
  expect(ui.posts).toHaveLength(0); expect(ui.get('imagex-message').value).toBe(message);
  expect(ui.get('imagex-message-counter').dataset.invalid).toBe('true');
});
test('a 32000-character consultation message is sent without trimming its whitespace or terminal sentinel', async () => {
  const ui = await expert(), message = '  ' + 'x'.repeat(31989) + ' END \n   ';
  expect(message.length).toBe(32000);
  ui.get('imagex-message').value = message; await ui.fire('imagex-message', 'input');
  expect(ui.get('imagex-send').disabled).toBe(false);
  await ui.fire('imagex-chat-form', 'submit'); expect(ui.posts[1].body.message).toBe(message);
});
test('editing a proposal beyond the final budget preserves the edit and blocks apply including the constraint suffix', async () => {
  const ui = await expert(); await ui.fire('imagex-plan');
  ui.get('imagex-proposal-prompt').value = 'x'.repeat(7990); await ui.fire('imagex-proposal-prompt', 'input');
  expect(ui.get('imagex-apply').disabled).toBe(true);
  await ui.fire('imagex-apply'); expect(ui.apply).not.toHaveBeenCalled();
  expect(ui.get('imagex-proposal-prompt').value).toBe('x'.repeat(7990));
});
test('a padded proposal above 8000 raw units stays intact and blocks Apply even when its trimmed composition fits', async () => {
  const ui = await expert({ constraints: { version: 1, items: [] } }); await ui.fire('imagex-plan');
  const prompt = ' '.repeat(20) + 'x'.repeat(7990);
  expect(contract.compose(prompt, ui.current.constraints)).toHaveLength(7990);
  ui.get('imagex-proposal-prompt').value = prompt; await ui.fire('imagex-proposal-prompt', 'input');
  expect(ui.get('imagex-apply').disabled).toBe(true);
  await ui.fire('imagex-apply'); expect(ui.apply).not.toHaveBeenCalled();
  expect(ui.get('imagex-proposal-prompt').value).toBe(prompt);
  ui.get('imagex-proposal-prompt').value = 'x'.repeat(7990); await ui.fire('imagex-proposal-prompt', 'input');
  expect(ui.get('imagex-apply').disabled).toBe(false);
});
test.each(['prompt', 'seed', 'referenceEpoch'])('a changed %s still blocks stale proposal application', async field => {
  const ui = await expert(); await ui.fire('imagex-plan');
  ui.current[field] = field === 'referenceEpoch' ? 2 : 'Changed'; ui.controller.refresh();
  expect(ui.get('imagex-apply').disabled).toBe(true);
  await ui.fire('imagex-apply'); expect(ui.apply).not.toHaveBeenCalled();
});
test('invalid exact constraints prevent consultation while preserving their text', async () => {
  const constraints = { version: 1, items: [{ id: 'title', kind: 'exact-text', text: 'x'.repeat(301) }] };
  const ui = await expert({ constraints }); await ui.fire('imagex-plan');
  expect(ui.posts).toHaveLength(0); expect(ui.current.constraints).toEqual(constraints);
  expect(ui.get('imagex-plan').disabled).toBe(true);
});
test('a reference identity changed while creating a session invalidates the original proposal', async () => {
  let release; const sessionPending = new Promise(resolve => { release = resolve; });
  const ui = await expert({ sessionPending }); await ui.fire('imagex-plan');
  ui.current.referenceEpoch += 1; release(); await settle();
  expect(ui.posts).toHaveLength(2); expect(ui.get('imagex-apply').disabled).toBe(true);
});
test('Hermes unavailability explains manual reduction while leaving the complete draft untouched', async () => {
  const ui = await expert({ available: false }), original = ui.current.prompt;
  expect(ui.get('imagex-plan').disabled).toBe(true);
  expect(ui.get('imagex-planning-help').textContent).toContain('indisponible');
  await ui.fire('imagex-plan'); expect(ui.posts).toHaveLength(0); expect(ui.current.prompt).toBe(original);
});
