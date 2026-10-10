'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../../public/js/image-text-editor.js'), 'utf8');
const originalId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const operation = (id = originalId) => ({ id, state: 'completed', runtimeRestored: true,
  artifact: { width: 400, height: 200, sha256: 'a'.repeat(64), url: 'https://untrusted.invalid/image' } });
const source = { operationId: 'offline', sha256: 'a'.repeat(64), width: 400, height: 200,
  dataUrl: 'data:image/png;base64,c3ludGhldGlj' };
const stored = () => ({ schema: 'synthetic', source: { ...source }, labels: [{ id: 'saved-label', text: 'Exact',
  x: .3, y: .4, fontSize: 25, color: '#ffffff', background: null, align: 'left' }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = () => ({ ok: true, headers: { get: () => '100' }, blob: async () => new Blob(['synthetic'], { type: 'image/png' }) });

function browser(op = operation()) {
  const fields = {}, listeners = {}, download = jest.fn();
  const element = name => {
    const events = {}, children = [];
    return { name, value: '', textContent: '', hidden: false, disabled: false, files: [], checked: true,
      addEventListener: (type, handler) => { events[type] = handler; },
      removeEventListener: type => { delete events[type]; },
      trigger: (type, event = {}) => events[type]?.(event),
      append: child => children.push(child), replaceChildren: () => { children.length = 0; },
      options: children, focus: jest.fn(), checkValidity: () => true,
      getContext: () => ({ save() {}, restore() {}, beginPath() {}, arc() {}, stroke() {} }),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
      remove: jest.fn(), click: download, toBlob: callback => callback(new Blob(['PNG'])) };
  };
  const engine = { MAX_JSON_BYTES: 1000000, MAX_LABELS: 100, MAX_TEXT_LENGTH: 300, MAX_FONT_SIZE: 1024,
    create: jest.fn(value => ({ schema: 'synthetic', source: value, labels: [] })),
    validate: jest.fn(value => {
      if (value.labels.some(label => Array.from(label.text).length > 300)) throw new Error('Label text exceeds the character limit.');
      return JSON.parse(JSON.stringify(value));
    }),
    parse: jest.fn(value => JSON.parse(value)), stringify: jest.fn(value => JSON.stringify(value)),
    verifySource: jest.fn(async () => ({})), draw: jest.fn(), svg: jest.fn(() => '<svg/>') };
  const fetch = jest.fn(async () => reply()), confirm = jest.fn(() => true);
  const window = { fetch, confirm, ImageTextProject: engine,
    setTimeout: callback => callback(), addEventListener: (name, handler) => { listeners[name] = handler; },
    removeEventListener: name => { delete listeners[name]; } };
  class SyntheticImage {
    constructor() { this.naturalWidth = 400; this.naturalHeight = 200; }
    set src(value) { this.value = value; Promise.resolve().then(() => this.onload()); }
  }
  class SyntheticReader {
    readAsDataURL() { this.result = source.dataUrl; Promise.resolve().then(() => this.onload()); }
  }
  const document = { getElementById: id => fields[id] || (fields[id] = element(id)),
    createElement: name => element(name), body: { append() {} } };
  const urls = { createObjectURL: jest.fn(() => 'blob:synthetic'), revokeObjectURL: jest.fn() };
  vm.runInNewContext(code, { window, document, Blob, URL: urls, Image: SyntheticImage,
    FileReader: SyntheticReader, AbortController });
  let context = { operation: op, locked: false };
  const controller = window.ImageTextEditor.init({ getContext: () => context, fetchImpl: fetch });
  return { engine, fetch, confirm, controller, urls, download,
    field: name => fields[`image-text-${name}`],
    setContext: value => { context = value; controller.refresh(); },
    import: async value => { fields['image-text-file'].files = [{ size: 100, text: async () => JSON.stringify(value) }];
      await fields['image-text-file'].trigger('change'); },
    prepare: () => fields['image-text-prepare'].trigger('click') };
}

test('prepare loads only the canonical archived operation path and verifies before displaying', async () => {
  const b = browser(); await b.prepare();
  expect(b.fetch).toHaveBeenCalledWith(`/api/images/operations/${originalId}/image`, expect.objectContaining({ credentials: 'same-origin' }));
  expect(b.engine.verifySource).toHaveBeenCalledTimes(1);
  expect(b.field('workspace').hidden).toBe(false);
  expect(b.field('canvas').width).toBe(400); expect(b.field('canvas').height).toBe(200);
});

test('incomplete, locked and malformed operation identities never fetch an original', async () => {
  const b = browser({ ...operation(), runtimeRestored: false });
  await b.prepare(); expect(b.fetch).not.toHaveBeenCalled(); expect(b.field('prepare').disabled).toBe(true);
  b.setContext({ operation: operation(), locked: true }); await b.prepare(); expect(b.fetch).not.toHaveBeenCalled();
  b.setContext({ operation: operation('../other'), locked: false }); await b.prepare(); expect(b.fetch).not.toHaveBeenCalled();
});

test('a late original fetch cannot replace a project after selection changes', async () => {
  const b = browser(), pending = deferred(); b.fetch.mockReturnValueOnce(pending.promise);
  const opening = b.prepare(); b.setContext({ operation: operation(otherId), locked: false });
  pending.resolve(reply()); await opening;
  expect(b.engine.verifySource).not.toHaveBeenCalled(); expect(b.field('workspace').hidden).toBe(true);
  expect(b.field('prepare').disabled).toBe(false);
});

test('JSON can reopen without any selected operation, keeps exact text, and performs no API write', async () => {
  const b = browser(null); await b.import(stored());
  expect(b.fetch).not.toHaveBeenCalled(); expect(b.field('workspace').hidden).toBe(false);
  expect(b.field('content').value).toBe('Exact'); expect(b.field('status').textContent).toContain('indépendant');
  await b.field('json').trigger('click');
  expect(b.engine.stringify.mock.calls[0][0].labels[0].text).toBe('Exact');
  expect(b.download).toHaveBeenCalled(); expect(b.urls.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic');
});

test('dirty edits survive selection changes and replacement is refused when discard is declined', async () => {
  const b = browser(); await b.import(stored());
  b.field('content').value = 'Texte conservé'; b.field('content').trigger('input');
  b.setContext({ operation: operation(otherId), locked: false });
  expect(b.field('content').value).toBe('Texte conservé');
  b.confirm.mockReturnValue(false); await b.prepare();
  expect(b.confirm).toHaveBeenCalledTimes(1); expect(b.fetch).not.toHaveBeenCalled();
  expect(b.field('content').value).toBe('Texte conservé');
});

test('a tampered import preserves the current project and reports its failed image hash in French', async () => {
  const b = browser(); await b.import(stored());
  b.engine.verifySource.mockRejectedValueOnce(new Error('Source SHA-256 does not match the embedded image.'));
  await b.import({ ...stored(), labels: [] });
  expect(b.field('content').value).toBe('Exact');
  expect(b.field('error').hidden).toBe(false); expect(b.field('error').textContent).toContain('empreinte');
});

test('an import awaiting verification is invalidated by a selection reset', async () => {
  const b = browser(), pending = deferred(); b.engine.verifySource.mockReturnValueOnce(pending.promise);
  const opening = b.import(stored()); await Promise.resolve();
  b.setContext({ operation: null, locked: false }); pending.resolve({}); await opening;
  expect(b.field('workspace').hidden).toBe(true); expect(b.field('file').disabled).toBe(false);
});

test('click and keyboard placement change the editable anchor without altering the original source', async () => {
  const b = browser(); await b.import(stored());
  b.field('canvas').trigger('click', { clientX: 200, clientY: 100 });
  expect(b.field('x').value).toBe(50); expect(b.field('y').value).toBe(50);
  const preventDefault = jest.fn(); b.field('canvas').trigger('keydown', { key: 'ArrowRight', shiftKey: true, preventDefault });
  expect(preventDefault).toHaveBeenCalled(); expect(b.field('x').value).toBe(52.5);
  await b.field('json').trigger('click');
  const exported = b.engine.stringify.mock.calls[0][0]; expect(exported.source).toEqual(source);
  expect(exported.labels[0]).toMatchObject({ x: .525, y: .5 });
});

test('an invalid pending field blocks exports until that field is corrected', async () => {
  const b = browser(); await b.import(stored());
  b.field('x').value = ''; b.field('x').trigger('input');
  expect(b.field('json').disabled).toBe(true);
  b.field('color').value = '#123456'; b.field('color').trigger('input');
  await b.field('json').trigger('click'); expect(b.download).not.toHaveBeenCalled();
  b.field('x').value = '20'; b.field('x').trigger('input');
  expect(b.field('json').disabled).toBe(false); await b.field('json').trigger('click');
  expect(b.download).toHaveBeenCalled(); expect(b.engine.stringify.mock.calls[0][0].labels[0].x).toBe(.2);
});

test('301 characters remain invalid after a color change and never export the previous text', async () => {
  const b = browser(); await b.import(stored());
  b.field('content').value = 'x'.repeat(301); b.field('content').trigger('input');
  expect(b.field('error').textContent).toContain('300 caractères');
  b.field('color').value = '#123456'; b.field('color').trigger('input');
  await b.field('json').trigger('click'); expect(b.download).not.toHaveBeenCalled();
  expect(b.field('json').disabled).toBe(true);
  b.field('content').value = 'x'.repeat(300); b.field('content').trigger('input');
  await b.field('json').trigger('click'); expect(b.download).toHaveBeenCalled();
  expect(b.engine.stringify.mock.calls[0][0].labels[0].text).toHaveLength(300);
});

test.each([['x', '101'], ['size', '0']])('invalid %s prevents direct export calls', async (name, value) => {
  const b = browser(); await b.import(stored());
  b.field(name).checkValidity = () => false; b.field(name).value = value; b.field(name).trigger('input');
  await b.field('png').trigger('click'); await b.field('svg').trigger('click'); await b.field('json').trigger('click');
  expect(b.download).not.toHaveBeenCalled(); expect(b.field('json').disabled).toBe(true);
  expect(b.field('status').textContent).toContain('Modifications');
});

test('canvas placement never discards an invalid pending text or enables exporting its previous value', async () => {
  const b = browser(); await b.import(stored());
  b.field('content').value = 'x'.repeat(301); b.field('content').trigger('input');
  b.field('canvas').trigger('click', { clientX: 200, clientY: 100 });
  b.field('canvas').trigger('keydown', { key: 'ArrowRight', shiftKey: true, preventDefault: jest.fn() });
  expect(b.field('content').value).toHaveLength(301); expect(b.field('x').value).toBe(30);
  expect(b.field('json').disabled).toBe(true);
  await b.field('json').trigger('click'); expect(b.download).not.toHaveBeenCalled();
});
