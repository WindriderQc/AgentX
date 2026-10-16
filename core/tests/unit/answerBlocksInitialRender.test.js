'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contract = require('../../../shared/answerBlocks');
const markedContext = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(path.dirname(require.resolve('marked/package.json')), 'lib/marked.umd.js'), 'utf8'), markedContext);

function harness(loadEnhancement) {
  const htmlWrites = [];
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text ?? this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { htmlWrites.push({ node: this, value }); this.html = value; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    querySelectorAll() { return []; }
  }
  const document = { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) };
  const marked = { parse: jest.fn(content => markedContext.marked.parse(content)) };
  const DOMPurify = { addHook: jest.fn(), sanitize: jest.fn(html => html) };
  const clipboard = { writeText: jest.fn(async () => {}) };
  const context = vm.createContext({ document, marked, DOMPurify, loadEnhancement, appendRagDisplay() {}, console,
    navigator: { clipboard }, setTimeout() {} });
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/chat/chat-message-render.js'), 'utf8')
    .replace(/^import[^\n]+\n/m, '').replace(/^export \{[^\n]+\n/gm, '').replace(/export function /g, 'function ')
    .replace("import('./answer-blocks-render.js')", 'loadEnhancement()');
  vm.runInContext(`${source}\nthis.render = renderMessage;`, context);
  const chatWindow = document.createElement('div');
  return { marked, DOMPurify, htmlWrites, clipboard, chatWindow,
    render(message) { context.render(message, { history: [], showStats: false }, { chatWindow }); return chatWindow.children.at(-1); } };
}
const hostile = () => contract.normalizeMessage({ role: 'assistant', content: '<pre>', answerBlocks: {
  schema: contract.SCHEMA, blocks: [{ kind: 'table', title: 'Table', columns: ['Value'],
    rows: [['</pre><img src="/table-data-fetch"><a href="/table-action">click</a>']] }]
} });

test.each(['delayed', 'unavailable'])('combined fallback stays literal before %s enhancement despite open narrative HTML', async availability => {
  const message = hostile();
  // Establish why a fenced suffix alone is insufficient with this real parser.
  expect(markedContext.marked.parse(message.content)).toContain('<img src="/table-data-fetch">');
  const load = jest.fn(() => availability === 'delayed' ? new Promise(() => {}) : Promise.reject(new Error('Missing module')));
  const ui = harness(load), bubble = ui.render(message);
  await Promise.resolve(); await Promise.resolve();
  const body = bubble.children.find(child => child.className === 'message-body');
  expect(body.textContent).toBe(message.content);
  expect(body.style.whiteSpace).toBe('pre-wrap');
  expect(ui.marked.parse).not.toHaveBeenCalled();
  expect(ui.DOMPurify.sanitize).not.toHaveBeenCalled();
  expect(ui.htmlWrites.some(write => write.node === body)).toBe(false);
  const actions = bubble.children.find(child => child.className === 'message-actions');
  actions.children.find(child => child.title === 'Copy').listeners.click();
  expect(ui.clipboard.writeText).toHaveBeenCalledWith(message.content);
});

test.each([null, false, { schema: 'future/version', blocks: [] }, { schema: contract.SCHEMA, blocks: [{}] }])(
  'every present unsupported block value keeps complete literal fallback: %p', answerBlocks => {
    const ui = harness(() => new Promise(() => {}));
    const message = { role: 'assistant', content: '<pre></pre><img src="/table-data-fetch">', answerBlocks };
    const bubble = ui.render(message), body = bubble.children.find(child => child.className === 'message-body');
    expect(body.textContent).toBe(message.content);
    expect(ui.marked.parse).not.toHaveBeenCalled();
    expect(ui.DOMPurify.sanitize).not.toHaveBeenCalled();
    expect(ui.htmlWrites.some(write => write.node === body)).toBe(false);
  });

test('legacy messages without block data retain ordinary Markdown rendering', () => {
  const ui = harness(jest.fn()), bubble = ui.render({ role: 'assistant', content: '**Legacy text**', answerBlocks: undefined });
  const body = bubble.children.find(child => child.className === 'message-body');
  expect(ui.marked.parse).toHaveBeenCalledWith('**Legacy text**');
  expect(body.html).toContain('<strong>Legacy text</strong>');
});
