'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../../public/js/image-layout-guide');
const code = fs.readFileSync(path.join(__dirname, '../../public/js/image-layout-guide.js'), 'utf8');
const zone = extra => ({ id: 'zone-1', name: 'Atelier · café 👋', x: .1, y: .2, width: .3, height: .25, color: '#c5d9cf', ...extra });
const saved = extra => ({ schema: engine.SCHEMA, width: 1024, height: 1024, boxes: [zone()], ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function browser(initial = {}) {
  const elements = {}, windowEvents = {}, downloads = [], drawCalls = [], callbacks = [];
  let context = { locked: false, width: 1024, height: 1024, referenceCount: 0, guideAttached: false, ...initial };
  let pngReply = callback => callback(new Blob(['synthetic PNG'], { type: 'image/png' }));
  let dataReply = 'data:image/png;base64,c3ludGhldGlj';
  const drawing = { fillRect: jest.fn(), strokeRect: jest.fn(), save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    fillText: (...args) => drawCalls.push(args) };
  const make = name => {
    const events = {}, children = [];
    return { name, value: '', disabled: false, hidden: false, files: [], options: children,
      addEventListener: (type, handler) => { events[type] = handler; }, removeEventListener: type => { delete events[type]; },
      trigger: (type, event = {}) => events[type]?.(event), replaceChildren: () => { children.length = 0; }, append: child => children.push(child),
      checkValidity() { return this.valid !== false; }, focus: jest.fn(), getContext: () => drawing,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
      toBlob: callback => pngReply(callback), remove() {}, click() { downloads.push(this.download); } };
  };
  const document = { getElementById: id => elements[id] || (elements[id] = make(id)), createElement: make, body: { append() {} } };
  class Reader { readAsDataURL() { this.result = dataReply; Promise.resolve().then(() => this.onload()); } }
  const urls = { createObjectURL: jest.fn(() => 'blob:guide'), revokeObjectURL: jest.fn() };
  const confirm = jest.fn(() => true);
  const window = { document, FileReader: Reader, URL: urls, confirm, setTimeout: callback => callback(),
    addEventListener: (type, handler) => { windowEvents[type] = handler; }, removeEventListener: type => { delete windowEvents[type]; } };
  vm.runInNewContext(code, { window, Blob });
  const onReference = jest.fn(async reference => { callbacks.push(reference); context.guideAttached = true; context.referenceCount++; });
  const onRemoveReference = jest.fn(async () => { context.guideAttached = false; context.referenceCount--; });
  const controller = window.ImageLayoutGuide.init({ getContext: () => context, onReference, onRemoveReference });
  const field = name => elements[`image-layout-${name}`];
  return { controller, field, onReference, onRemoveReference, urls, confirm, downloads, drawCalls, windowEvents, callbacks,
    setContext: value => { context = { ...context, ...value }; controller.refresh(); },
    setPng: fn => { pngReply = fn; }, setData: value => { dataReply = value; },
    import: async project => { field('file').files = [{ size: 100, text: async () => JSON.stringify(project) }]; await field('file').trigger('change'); },
    edit: (name, value) => { field(name).value = value; field(name).trigger('input'); } };
}

test('portable guide JSON preserves relative composition, Unicode names and dimensions offline', () => {
  const original = saved(), copy = engine.parse(engine.stringify(original));
  expect(copy).toEqual(original); copy.boxes[0].name = 'Changed'; expect(original.boxes[0].name).toBe('Atelier · café 👋');
  expect(engine.renderSize(saved({ width: 2752, height: 1536 }))).toEqual({ width: 1536, height: 857 });
  expect(engine.renderSize(saved({ width: 512, height: 1024 }))).toEqual({ width: 512, height: 1024 });
});

test.each([
  { schema: 'unknown' }, { href: 'https://untrusted.invalid' }, { width: 16384 }, { height: NaN },
  { width: 8192, height: 8192 }, { width: 8192, height: 256 }, { boxes: [zone({ x: .8 })] }, { boxes: [zone({ width: .001 })] },
  { boxes: [zone({ name: '\u0000' })] }, { boxes: [zone({ name: 'x'.repeat(81) })] },
  { boxes: [zone({ color: 'url(javascript:alert(1))' })] }, { boxes: [zone(), zone()] },
  { boxes: [zone({ script: 'untrusted' })] }
])('unsupported, excessive or unsafe project values refuse: %j', extra => {
  expect(() => engine.validate(saved(extra))).toThrow();
});

test('JSON parsing rejects oversized UTF-8 and malformed data before applying projects', () => {
  expect(() => engine.parse('😀'.repeat(17000))).toThrow('volumineux');
  expect(() => engine.parse('{')).toThrow('JSON');
  expect(() => engine.validate(saved({ boxes: Array.from({ length: 25 }, (_, i) => zone({ id: `zone-${i}` })) }))).toThrow('24');
});

test('box names are drawn as plain text, without HTML, on a bounded PNG canvas', () => {
  const b = browser(); b.field('format').trigger('click'); b.field('add').trigger('click');
  b.edit('name', '<script>literal & café</script>');
  expect(b.drawCalls.at(-1)[0]).toBe('<script>literal & café</script>');
  expect(b.field('canvas').width).toBe(1024); expect(b.field('canvas').height).toBe(1024);
});

test('joining a guide calls only the reference callback and never triggers generation', async () => {
  const b = browser({ referenceCount: 1 }); await b.import(saved());
  await b.field('attach').trigger('click');
  expect(b.onReference).toHaveBeenCalledTimes(1);
  expect(b.callbacks[0]).toEqual({ base64: 'c3ludGhldGlj', mimeType: 'image/png', label: 'Esquisse de composition · 1024 × 1024' });
  expect(b.field('remove-reference').hidden).toBe(false);
  await b.field('remove-reference').trigger('click'); expect(b.onRemoveReference).toHaveBeenCalledTimes(1);
});

test('two references including a parent refuse attachment, while updating the existing guide fits', async () => {
  const full = browser({ referenceCount: 2 }); await full.import(saved()); await full.field('attach').trigger('click');
  expect(full.onReference).not.toHaveBeenCalled(); expect(full.field('attach').disabled).toBe(true);
  const replacing = browser({ referenceCount: 2, guideAttached: true }); await replacing.import(saved());
  await replacing.field('attach').trigger('click'); expect(replacing.onReference).toHaveBeenCalledTimes(1);
});

test('locks refuse project mutation and attachment even when handlers are called directly', async () => {
  const b = browser(); await b.import(saved()); b.setContext({ locked: true });
  b.field('add').trigger('click'); b.edit('name', 'Blocked'); await b.field('attach').trigger('click'); await b.field('json').trigger('click');
  expect(b.field('zone').options).toHaveLength(1); expect(b.onReference).not.toHaveBeenCalled(); expect(b.downloads).toHaveLength(0);
});

test('wrong-format imports remain downloadable and require explicit adaptation before attachment', async () => {
  const b = browser({ width: 1536, height: 1024 }); await b.import(saved());
  expect(b.field('attach').disabled).toBe(true); expect(b.field('status').textContent).toContain('format');
  b.field('format').trigger('click'); expect(b.field('name').value).toBe('Atelier · café 👋');
  expect(b.field('attach').disabled).toBe(false); expect(b.field('canvas').width).toBe(1536);
});

test('an in-flight PNG cannot attach after a format or lock change', async () => {
  const b = browser(); await b.import(saved()); const pending = deferred();
  b.setPng(callback => pending.promise.then(callback));
  const opening = b.field('attach').trigger('click'); b.setContext({ width: 1536, locked: true });
  pending.resolve(new Blob(['PNG'], { type: 'image/png' })); await opening;
  expect(b.onReference).not.toHaveBeenCalled(); expect(b.field('attach').disabled).toBe(true);
});

test('reference capacity is rechecked after asynchronous PNG encoding', async () => {
  const b = browser(); await b.import(saved()); const pending = deferred(); b.setPng(callback => pending.promise.then(callback));
  const opening = b.field('attach').trigger('click'); b.setContext({ referenceCount: 2 });
  pending.resolve(new Blob(['PNG'], { type: 'image/png' })); await opening;
  expect(b.onReference).not.toHaveBeenCalled(); expect(b.field('error').textContent).toContain('références');
});

test('oversized PNG and oversized base64 refuse before the callback', async () => {
  const b = browser(); await b.import(saved()); b.setPng(callback => callback({ type: 'image/png', size: 2400000 }));
  await b.field('attach').trigger('click'); expect(b.onReference).not.toHaveBeenCalled(); expect(b.field('error').textContent).toContain('volumineuse');
  b.setPng(callback => callback(new Blob(['PNG'], { type: 'image/png' }))); b.setData('data:image/png;base64,' + 'A'.repeat(engine.MAX_BASE64_BYTES + 4));
  await b.field('attach').trigger('click'); expect(b.onReference).not.toHaveBeenCalled();
});

test('invalid visible edits remain invalid when another field changes, until all fields are corrected', async () => {
  const b = browser(); await b.import(saved()); b.edit('name', 'A'.repeat(81)); b.edit('color', '#c8dce3');
  expect(b.field('attach').disabled).toBe(true); await b.field('json').trigger('click'); expect(b.downloads).toHaveLength(0);
  b.edit('name', 'Correct'); b.edit('x', '90'); b.edit('color', '#c5d9cf'); expect(b.field('attach').disabled).toBe(true);
  b.edit('x', '20'); expect(b.field('attach').disabled).toBe(false);
});

test('click and keyboard positioning clamp the complete rectangle inside the guide', async () => {
  const b = browser(); await b.import(saved());
  b.field('canvas').trigger('click', { clientX: 400, clientY: 400 });
  expect(b.field('x').value).toBe(70); expect(b.field('y').value).toBe(75);
  const preventDefault = jest.fn(); b.field('canvas').trigger('keydown', { key: 'ArrowLeft', shiftKey: true, preventDefault });
  expect(b.field('x').value).toBe(69); expect(preventDefault).toHaveBeenCalled();
});

test('dirty replacement can be declined and failed imports preserve the current sketch', async () => {
  const b = browser(); await b.import(saved()); b.edit('name', 'Conservé'); b.confirm.mockReturnValueOnce(false);
  await b.import(saved({ boxes: [] })); expect(b.field('name').value).toBe('Conservé');
  await b.import(saved({ schema: 'unknown' })); expect(b.field('name').value).toBe('Conservé'); expect(b.field('error').hidden).toBe(false);
});

test('portable JSON downloads clear dirty state and object URLs are released', async () => {
  const b = browser(); await b.import(saved()); b.edit('name', 'Sauvegardé');
  const before = { preventDefault: jest.fn() }; b.windowEvents.beforeunload(before); expect(before.preventDefault).toHaveBeenCalled();
  await b.field('json').trigger('click'); expect(b.downloads).toContain('agentx-esquisse.json'); expect(b.urls.revokeObjectURL).toHaveBeenCalledWith('blob:guide');
  const after = { preventDefault: jest.fn() }; b.windowEvents.beforeunload(after); expect(after.preventDefault).not.toHaveBeenCalled();
  b.controller.destroy(); expect(b.windowEvents.beforeunload).toBeUndefined();
});
