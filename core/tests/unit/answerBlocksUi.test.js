'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const contract = require('../../../shared/answerBlocks');
const root = path.resolve(__dirname, '../..');
function renderer() {
  const source = fs.readFileSync(path.join(root, 'public/js/chat/answer-blocks-render.js'), 'utf8')
    .replace(/^import[^\n]+\n/, '').replace('export function', 'function');
  const context = { ...contract }; vm.createContext(context);
  vm.runInContext(`${source}\nthis.enhance = enhanceAnswerBlocks;`, context);
  return context.enhance;
}
function dom() {
  const doc = { createElement: tag => new Element(tag) };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.ownerDocument = doc; this._text = ''; }
    set textContent(text) { this._text = String(text); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('Block data must not be HTML'); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  return doc.createElement('div');
}
const input = () => contract.normalizeMessage({ role: 'assistant', content: 'This result remains uncertain.',
  answerBlocks: { schema: contract.SCHEMA, blocks: [{ kind: 'table', title: '<img src="https://example.test">',
    columns: ['<script>heading</script>'], rows: [['![pixel](https://example.test/leak)']] }] } });
const descendants = node => [node, ...node.children.flatMap(descendants)];

test('complete text fallback keeps hostile cells inert in the installed Markdown renderer', () => {
  const markedRoot = path.dirname(require.resolve('marked/package.json'));
  const context = {}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(markedRoot, 'lib/marked.umd.js'), 'utf8'), context);
  const message = input();
  message.answerBlocks.blocks[0].rows.push(['``````'], ['<script>alert(1)</script>']);
  const fallback = contract.tableFallback(message.answerBlocks);
  const html = context.marked.parse(fallback);
  expect(fallback.startsWith('```````text\n')).toBe(true);
  expect(html).not.toMatch(/<(?:img|script|a)\b/i);
  expect(html).toContain('&lt;script&gt;');
});

test('shared renderer builds literal accessible table nodes and retains narrative plus exact text version', () => {
  const message = input(), body = dom(); body.textContent = message.content;
  expect(renderer()(body, message)).toBe(true);
  const nodes = descendants(body);
  expect(nodes.find(node => node.tagName === 'caption').textContent).toBe(message.answerBlocks.blocks[0].title);
  expect(nodes.find(node => node.tagName === 'th').scope).toBe('col');
  expect(nodes.find(node => node.tagName === 'td').textContent).toBe('![pixel](https://example.test/leak)');
  expect(nodes.some(node => ['img', 'script', 'a', 'form'].includes(node.tagName))).toBe(false);
  expect(nodes.find(node => node.className === 'answer-block-table-wrap').tabIndex).toBe(0);
  expect(nodes.find(node => node.className === 'answer-block-narrative').textContent).toBe('This result remains uncertain.');
  expect(nodes.find(node => node.className === 'answer-block-fallback').textContent).toBe(message.content);
});

test('unsupported, malformed and incomplete historical data never replace rendered fallback', () => {
  for (const mutate of [message => { message.answerBlocks.schema = 'future/v2'; },
    message => { message.answerBlocks.blocks[0].kind = 'form'; },
    message => { message.answerBlocks.blocks[0].rows = [[3]]; },
    message => { message.content = 'Incomplete fallback.'; }]) {
    const message = input(); mutate(message); const body = dom(); body.textContent = message.content;
    expect(renderer()(body, message)).toBe(false);
    expect(body.textContent).toBe(message.content);
  }
  const body = dom(), message = input(); body.textContent = message.content;
  expect(renderer()(body, message, { renderProse() { throw new Error('Rejected rendering'); } })).toBe(false);
  expect(body.textContent).toBe(message.content);
});

test('production history restoration carries the declared block with its original message identity and content', async () => {
  const message = { ...input(), _id: '100000000000000000000001' };
  const source = fs.readFileSync(path.join(root, 'public/js/chat/chat-history.js'), 'utf8')
    .replace(/^import[^\n]+\n/m, '').replace(/^export \{[^\n]+\n/m, '').replace(/export /g, '');
  const context = { fetch: async () => ({ ok: true, json: async () => ({ data: { _id: '100000000000000000000002', messages: [message] } }) }),
    document: { querySelectorAll: () => [], querySelector: () => null }, console };
  vm.createContext(context); vm.runInContext(`${source}\nthis.load = loadConversation;`, context);
  const appendMessage = jest.fn();
  expect(await context.load('100000000000000000000002', { stats: {} }, { chatWindow: {} },
    { appendMessage, updateConversationStats() {} }, true)).toBe(true);
  expect(appendMessage.mock.calls[0][0]).toEqual(expect.objectContaining({ id: message._id, content: message.content, answerBlocks: message.answerBlocks }));
});

test('the optional stylesheet is imported before rules', () => {
  const css = fs.readFileSync(path.join(root, 'public/css/chat-inline.css'), 'utf8');
  expect(css.indexOf('@import url("answer-blocks.css")')).toBeLessThan(css.indexOf('.modal-overlay'));
});
