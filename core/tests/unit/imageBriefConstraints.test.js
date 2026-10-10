'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const constraints = require('../../public/js/image-brief-constraints');
const { validate: imageRequest } = require('../../src/services/images/imageService');
const manifest = () => ({ version: 1, items: [
  { id: 'text-fixture', kind: 'exact-text', text: 'École & façade\nDe\u0301couverte 💡' },
  { id: 'element-fixture', kind: 'required-element', text: 'Trois objets' },
  { id: 'composition-fixture', kind: 'composition', text: 'Trois objets alignés en bas' }
] });
const config = { defaultProfile: 'quick', profiles: { quick: { family: 'klein', maxPixels: 1048576 } } };
const request = () => ({ actionKey: 'fixture-key', prompt: 'A warm scene', profile: 'quick', width: 1024, height: 1024, seed: 42 });

test('retains exact user intent, order, Unicode and multiline text without extracting prose', () => {
  const input = manifest(), before = JSON.stringify(input), clean = constraints.validate(input);
  expect(clean).toEqual(input); expect(clean).not.toBe(input); expect(clean.items[0]).not.toBe(input.items[0]);
  const composed = constraints.compose('A scene', input);
  for (const item of input.items) expect(composed).toContain(item.text);
  expect(constraints.visual(composed, input)).toBe('A scene');
  expect(constraints.compose(composed, input)).toBe(composed);
  expect(constraints.compose('three objects and a title', undefined)).toBe('three objects and a title');
  expect(JSON.stringify(input)).toBe(before);
});

test('never truncates an oversized composed prompt or interprets a similar constraint block', () => {
  const similar = 'A scene\n\nCONTRAINTES EXPLICITES À CONSERVER\nAn unrelated block';
  expect(constraints.visual(similar, manifest())).toBe(similar);
  expect(() => constraints.compose('x'.repeat(8000), manifest())).toThrow('dépassent');
  expect(constraints.compose('x'.repeat(8000))).toHaveLength(8000);
  expect(constraints.validate({ version: 1, items: [] })).toBeUndefined();
});

test('planning keeps a long original brief and the same exact suffix within a separate 32000 UTF-16 budget', () => {
  const original = 'Synthetic visual brief. '.repeat(450) + 'TERMINAL_SENTINEL';
  const value = manifest(), composed = constraints.composeBrief(original, value);
  expect(original.length).toBeGreaterThan(8000);
  expect(constraints.visual(composed, value)).toBe(original);
  expect(composed).toBe(original + '\n\n' + constraints.block(value));
  expect(constraints.composeBrief(composed, value)).toBe(composed);
  expect(() => constraints.compose(original, value)).toThrow('8 000');
  expect(constraints.MAX_PROMPT).toBe(8000); expect(constraints.MAX_BRIEF).toBe(32000);
});

test('planning and rendering limits count UTF-16 units, including the protected suffix, without cutting text', () => {
  expect(constraints.composeBrief('💡'.repeat(16000))).toHaveLength(32000);
  expect(() => constraints.composeBrief('💡'.repeat(16000) + 'x')).toThrow('32 000');
  const value = manifest(), suffixLength = constraints.block(value).length + 2;
  expect(constraints.composeBrief('x'.repeat(32000 - suffixLength), value)).toHaveLength(32000);
  expect(() => constraints.composeBrief('x'.repeat(32001 - suffixLength), value)).toThrow('32 000');
  expect(constraints.compose('x'.repeat(8000 - suffixLength), value)).toHaveLength(8000);
  expect(() => constraints.compose('x'.repeat(8001 - suffixLength), value)).toThrow('8 000');
});

test.each([
  value => { value.version = 2; }, value => { value.extra = true; },
  value => { value.items[0].kind = 'inferred'; }, value => { value.items[0].kind = ['composition']; }, value => { value.items[0].text = ''; },
  value => { value.items[0].text = '💡'.repeat(301); }, value => { value.items[0].text = '\u0000'; },
  value => { value.items[0].text = '\uD800'; }, value => { value.items[0].extra = true; },
  value => { value.items.push({ ...value.items[0] }); }, value => { value.items[0].id = '<script>'; },
  value => { value.items = Array.from({ length: 21 }, (_, n) => ({ id: `fixture-${n}`, kind: 'composition', text: 'a' })); },
  value => { value.items = Array.from({ length: 20 }, (_, n) => ({ id: `fixture-${n}`, kind: 'composition', text: 'a'.repeat(300) })); }
])('rejects invalid intent snapshots', mutate => {
  const value = manifest(); mutate(value); expect(() => constraints.validate(value)).toThrow();
});

test('native requests persist free visual text and the exact protected snapshot while hashing changes', () => {
  const body = { ...request(), constraints: manifest() }, input = imageRequest(body, config);
  expect(input.request.visualPrompt).toBe(body.prompt);
  expect(input.request.constraints).toEqual(body.constraints);
  expect(input.request.prompt).toBe(constraints.compose(body.prompt, body.constraints));
  expect(imageRequest({ ...body, prompt: input.request.prompt }, config).requestHash).toBe(input.requestHash);
  const modified = manifest(); modified.items[0].text = 'Another exact title';
  expect(imageRequest({ ...body, constraints: modified }, config).requestHash).not.toBe(input.requestHash);
  expect(imageRequest(request(), config).request).toEqual({ prompt: 'A warm scene', width: 1024, height: 1024, seed: 42 });
  expect(() => imageRequest({ ...body, prompt: 'x'.repeat(8000) }, config)).toThrow('dépassent');
});

function browserUi() {
  const elements = new Map();
  const element = tag => ({ tag, value: '', children: [], events: {}, dataset: {},
    addEventListener(name, handler) { this.events[name] = handler; }, setAttribute() {},
    append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; },
    querySelectorAll(tagName) { return this.children.flatMap(child => [child, ...child.querySelectorAll(tagName)]).filter(child => child.tag === tagName); }
  });
  const get = id => { if (!elements.has(id)) elements.set(id, element('div')); return elements.get(id); };
  let input = { locked: false, prompt: 'A scene' };
  const onChange = jest.fn(), browser = { document: { getElementById: get, createElement: element }, crypto: { randomUUID: () => 'fixture-id' } };
  browser.window = browser;
  for (const file of ['image-brief-constraints.js', 'image-brief-constraints-ui.js']) vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/js', file), 'utf8'), browser);
  const ui = browser.AgentXImageConstraints.mount({ getContext: () => input, onChange });
  return { get, ui, onChange, setContext: value => { input = value; ui.refresh(); } };
}

test('constraint editor accepts only explicit entries and exposes invalid drafts safely', () => {
  const b = browserUi();
  expect(b.ui.getValue()).toBeUndefined();
  b.get('image-constraint-kind').value = 'exact-text'; b.get('image-constraint-text').value = 'École';
  b.get('image-constraint-add').events.click();
  expect(b.ui.getValue().items[0].text).toBe('École');
  expect(b.onChange).toHaveBeenCalledTimes(1);
  const textarea = b.get('image-constraint-list').querySelectorAll('textarea')[0];
  textarea.value = ''; textarea.events.input();
  expect(b.ui.isValid()).toBe(false); expect(b.ui.getValue({ draft: true })).toBeUndefined();
  expect(() => b.ui.getValue()).toThrow();
  textarea.value = 'Corrected'; textarea.events.input(); expect(b.ui.isValid()).toBe(true);
  b.setContext({ locked: true, prompt: 'A scene' }); expect(textarea.disabled).toBe(true);
  b.ui.reset(); expect(b.ui.getValue()).toBeUndefined();
});
