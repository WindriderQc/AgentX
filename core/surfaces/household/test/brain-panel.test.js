'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.textContent = ''; this.hidden = false; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  addEventListener(type, handler) { this.listeners[type] = handler; }
}
global.document = { createElement: tag => new Element(tag) };
require('../public/brain-panel');
const { create, quietState, mayInterject } = globalThis.NestorBrain;

const REVIEW = { traceId: 't1', suggestions: ['Et un insecte?', 'Combien de pattes a un crabe?'], corrections: [],
  revisions: [{ title: 'Pattes', body: 'Araignée : 8 pattes' }], interjection: { text: 'Petite correction.', urgent: false } };

function panel(review = REVIEW) {
  const container = new Element('section'), asked = [], revised = [], spoken = [], urls = [];
  const brain = create(container, { base: '/api/voice-personas/family/sessions',
    fetchImpl: async url => { urls.push(url); return { ok: true, json: async () => ({ data: { review } }) }; },
    onAsk: question => asked.push(question), onRevision: block => revised.push(block), onInterject: remark => spoken.push(remark) });
  return { container, brain, asked, revised, spoken, urls };
}

test('quiet lasts for its time or for the conversation, and an urgent remark still speaks', () => {
  const now = 1000;
  assert.equal(quietState('', now).until, 0);
  assert.equal(quietState('15', now).until, now + 15 * 60000);
  assert.equal(quietState('conversation', now).until, Infinity);
  assert.equal(mayInterject({ until: 0 }, { text: 'a' }, now), true);
  assert.equal(mayInterject({ until: now + 1 }, { text: 'a' }, now), false);
  assert.equal(mayInterject({ until: Infinity }, { text: 'Attention!', urgent: true }, now), true);
  assert.equal(mayInterject({ until: 0 }, null, now), false);
});

test('a review becomes tappable questions, a revised block and at most one remark', async () => {
  const h = panel();
  assert.equal(h.container.hidden, true);
  await h.brain.follow('session 1', 't1');
  assert.equal(h.urls[0], '/api/voice-personas/family/sessions/session%201/brain?after=t1');
  const buttons = h.container.children[1].children;
  assert.deepEqual(buttons.map(button => button.textContent), REVIEW.suggestions);
  assert.equal(h.container.hidden, false);
  buttons[1].listeners.click();
  assert.deepEqual(h.asked, ['Combien de pattes a un crabe?']);
  assert.deepEqual(h.revised, [{ id: 'brain-t1-0', kind: 'text', title: 'Révisé · Pattes', body: 'Araignée : 8 pattes' }]);
  assert.deepEqual(h.spoken, [REVIEW.interjection]);
  h.brain.cancel();
  assert.equal(h.container.hidden, true, 'a new turn clears the previous suggestions');
});

test('quiet keeps the remark unspoken, and a superseded review is ignored', async () => {
  const h = panel();
  const select = h.container.children[2].children[0];
  select.value = 'conversation'; select.listeners.change();
  await h.brain.follow('s', 't1');
  assert.deepEqual(h.spoken, []);
  h.brain.reset();
  assert.equal(h.brain.quiet.until, 0, 'quiet for this conversation ends with it');

  const late = panel();
  const pending = late.brain.follow('s', 't1');
  late.brain.cancel();
  assert.equal(await pending, null);
  assert.deepEqual(late.spoken, []);
});
