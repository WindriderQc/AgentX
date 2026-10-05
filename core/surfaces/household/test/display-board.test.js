'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A minimal DOM: enough for the board to build its cards without a browser.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.hidden = false;
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  append(...nodes) { nodes.forEach(node => { node.parent = this; }); this.children.push(...nodes); }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  get childElementCount() { return this.children.length; }
  get lastElementChild() { const last = this.children.at(-1); return { remove: () => this.children.pop(), ...last }; }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find?.(predicate);
      if (nested) return nested;
    }
    return null;
  }
  text() { return [this.textContent, ...this.children.map(child => child.text?.() || '')].join(' '); }
}
global.document = { createElement: tag => new Element(tag) };
require('../public/display-board');
const { create, safeUrl } = globalThis.DisplayBoard;

test('the board stays hidden until something is shown, newest first', () => {
  const container = new Element('section');
  const board = create(container, { secrets: true });
  assert.equal(container.hidden, true);
  board.add({ id: 'b1', kind: 'list', title: 'Étapes', body: '1. a' });
  board.add({ id: 'b2', kind: 'code', title: '', body: 'npm test' });
  assert.equal(container.hidden, false);
  const list = container.children[1];
  assert.deepEqual(list.children.map(card => card.dataset.kind), ['code', 'list']);
  board.clear();
  assert.equal(container.hidden, true);
});

test('a secret is masked until revealed and never rendered in Famille', () => {
  const container = new Element('section');
  create(container, { secrets: false }).add({ id: 'b1', kind: 'secret', title: 'Clé', body: 'sk-live' });
  assert.equal(container.hidden, true, 'Famille drops a secret block entirely');

  const privateBoard = new Element('section');
  create(privateBoard, { secrets: true }).add({ id: 'b1', kind: 'secret', title: 'Clé', body: 'sk-live' });
  const card = privateBoard.children[1].children[0];
  assert.doesNotMatch(card.text(), /sk-live/);
  const value = card.find(node => node.dataset.masked === 'true');
  const reveal = card.find(node => node.textContent === 'Afficher');
  reveal.listeners.click();
  assert.equal(value.textContent, 'sk-live');
  reveal.listeners.click();
  assert.doesNotMatch(value.textContent, /sk-live/);
});

test('a restored secret says it was not retained', () => {
  const container = new Element('section');
  create(container, { secrets: true }).restore([{ id: 'b1', kind: 'secret', title: 'Clé', body: '', redacted: true }]);
  assert.match(container.text(), /non conservé/);
});

test('links open http(s) targets and exact same-origin Core image operations', () => {
  assert.equal(safeUrl('https://example.test/a'), 'https://example.test/a');
  assert.equal(safeUrl('www.example.test'), 'https://www.example.test/');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  const studio = '/images?operation=33333333-3333-4333-8333-333333333333';
  assert.equal(safeUrl(studio), studio);
  assert.equal(safeUrl('//external.test/images?operation=33333333-3333-4333-8333-333333333333'), '');
  assert.equal(safeUrl(studio + '&redirect=https://external.test'), '');
  const container = new Element('section');
  create(container).add({ id: 'studio', kind: 'link', title: 'Studio d’images', body: studio });
  assert.equal(container.find(element => element.tagName === 'A').href, studio);
});

test('the page loads the board before the conversation that mounts it', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.indexOf('display-board.js') > 0 && html.indexOf('display-board.js') < html.indexOf('conversation-page.js'));
  assert.ok(html.includes('display-board.css'));
});

test('pictures go to their own zone, with provenance, and a missing one says so', () => {
  const text = new Element('section'), visual = new Element('section');
  const screen = globalThis.DisplayBoard.createScreen({ text, visual }, { secrets: false });
  screen.add({ id: 'b1', kind: 'list', title: '', body: '- a' });
  screen.add({ id: 'b2', kind: 'image', source: 'web', title: 'Girafe', body: 'girafe', status: 'found',
    image: { url: 'https://images.example.test/g.jpg', origin: 'https://zoo.example.test/g', originTitle: 'Zoo', sourceLabel: 'Internet' } });
  assert.deepEqual(text.children[1].children.map(card => card.dataset.kind), ['list']);
  assert.deepEqual(visual.children[1].children.map(card => card.dataset.kind), ['image']);
  const card = visual.children[1].children[0];
  const img = card.find(node => node.tagName === 'IMG');
  assert.equal(img.src, 'https://images.example.test/g.jpg');
  assert.equal(img.referrerPolicy, 'no-referrer');
  assert.equal(card.find(node => node.tagName === 'A').href, 'https://zoo.example.test/g');
  assert.match(card.text(), /Internet/);

  screen.add({ id: 'b3', kind: 'image', source: 'photos', title: '', body: 'cabane', status: 'found',
    image: { url: '/api/voice-personas/family/visuals/file?source=photos&path=a.jpg', sourceLabel: 'Photos de la famille' } });
  assert.equal(visual.children[1].children[0].find(node => node.tagName === 'IMG').src, '/api/voice-personas/family/visuals/file?source=photos&path=a.jpg');
  for (const image of [null, { url: 'javascript:alert(1)' }, { url: '/etc/passwd' }]) {
    screen.add({ id: 'b4', kind: 'image', body: 'licorne', status: image ? 'found' : 'missing', image });
    const latest = visual.children[1].children[0];
    assert.equal(latest.find(node => node.tagName === 'IMG'), null);
    assert.match(latest.text(), /Aucune image trouvée pour « licorne »/);
  }
  screen.clear();
  assert.equal(text.hidden && visual.hidden, true);
});

test('a math picture is drawn by <llmx-stage> in the Images zone and its receipt goes back to the dock', async () => {
  const bus = new EventTarget(), receipts = [];
  globalThis.addEventListener = bus.addEventListener.bind(bus);
  globalThis.dispatchEvent = bus.dispatchEvent.bind(bus);
  globalThis.addEventListener('persona-scene-receipt', event => receipts.push(event.detail));
  const created = [];
  const originalCreate = document.createElement;
  document.createElement = tag => { const element = originalCreate(tag); if (tag === 'llmx-stage') created.push(element); return element; };
  globalThis.customElements = { get: name => name === 'llmx-stage', whenDefined: () => new Promise(() => {}) };
  try {
    const text = new Element('section'), visual = new Element('section');
    const screen = globalThis.DisplayBoard.createScreen({ text, visual }, { space: 'family' });
    screen.add({ key: 'scene', kind: 'scene', title: '8 + 5 = 13', scene: { kind: 'add', a: 8, b: 5 } });
    screen.add({ key: 'scene', kind: 'scene', title: 'On compte jusqu’à 12', scene: { kind: 'count', to: 12 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(visual.children[1].children.length, 1, 'the newer picture replaces the previous one');
    assert.equal(text.hidden, true, 'pictures never land in the text zone');
    assert.deepEqual(created.at(-1).scene, { kind: 'count', to: 12 });
    created.at(-1).listeners['llmx-scene-applied']();
    assert.deepEqual(receipts, [{ space: 'family', receipt: { status: 'applied' } }]);
    created.at(-1).listeners['llmx-scene-rejected']({ detail: { reason: 'out-of-bounds' } });
    assert.deepEqual(receipts.at(-1).receipt, { status: 'rejected', reason: 'out-of-bounds' });

    // Without the 3D element the caption is the picture, and the dock records that it was not drawn.
    globalThis.customElements = undefined;
    screen.add({ key: 'scene', kind: 'scene', title: '2 + 2 = 4', scene: { kind: 'add', a: 2, b: 2 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(visual.children[1].children[0].text(), /2 \+ 2 = 4/);
    assert.deepEqual(receipts.at(-1), { space: 'family', receipt: { status: 'rejected', reason: 'no-face' } });
  } finally {
    document.createElement = originalCreate;
    delete globalThis.customElements;
  }
});

test('bold written by the model shows as emphasis, not asterisks', () => {
  const container = new Element('section');
  create(container, {}).add({ id: 'b1', kind: 'list', title: '', body: '1. **Optimisation du RAG** : re-ranking' });
  const body = container.children[1].children[0].children[1];
  assert.deepEqual(body.children.map(child => [child.tagName, child.textContent]), [['SPAN', '1. '], ['STRONG', 'Optimisation du RAG'], ['SPAN', ' : re-ranking']]);
  assert.doesNotMatch(container.text(), /\*\*/);
});
