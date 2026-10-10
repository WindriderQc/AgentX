'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../../public/js/image-compare.js'), 'utf8');
const parentId = '11111111-1111-4111-8111-111111111111', resultId = '22222222-2222-4222-8222-222222222222';
const sha = 'a'.repeat(64), resultSha = 'b'.repeat(64);
const metadata = (id, width = 400, height = 200) => ({ id, state: 'completed', runtimeRestored: true,
  artifact: { sha256: id === parentId ? sha : resultSha, width, height, url: 'https://untrusted.invalid/source' } });
const parent = { operationId: parentId, sha256: sha, width: 400, height: 200 };
function context(width = 400, height = 200) {
  return { operation: metadata(resultId, width, height), locked: false,
    details: { id: resultId, lineage: { version: 1, parent }, request: { constraints: { version: 1,
      items: [{ id: 'exact-1', kind: 'exact-text', text: 'Texte exact : Maison' }] } } } };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = '';
    this.files = []; this.style = {}; this.checked = true; this.disabled = false; this.hidden = false;
    this.scrollLeft = 0; this.scrollTop = 0; this.scrollWidth = 1000; this.scrollHeight = 800;
    this.clientWidth = 200; this.clientHeight = 200; this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  removeEventListener(type) { delete this.listeners[type]; }
  trigger(type, event = {}) { return this.listeners[type]?.(event); }
  append(...nodes) { nodes.forEach(node => { this.children.push(node); node.parentNode = this; }); }
  replaceChildren() { this.children.length = 0; }
  get options() { return this.children; }
  removeAttribute(name) { delete this[name]; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  querySelectorAll(selector) {
    const tags = selector.split(',');
    return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  closest() { return this.dataset.item ? this : this.parentNode?.closest(); }
}

function browser(initial = context()) {
  const fields = new Map(), objectBlobs = new Map(), downloads = [], body = new Element('body');
  let current = initial, urlIndex = 0;
  const field = name => {
    const id = `image-compare-${name}`;
    if (!fields.has(id)) fields.set(id, new Element());
    return fields.get(id);
  };
  field('mode').append(new Element('option'), new Element('option'));
  field('mode').value = 'side'; field('zoom').value = 'fit'; field('position').value = '50';
  const engine = { MAX_BASE64_BYTES: 64 * 1024 * 1024,
    create: jest.fn(source => ({ source, labels: [] })), verifySource: jest.fn(async () => ({})) };
  const fetch = jest.fn(async route => {
    if (route.endsWith('/image')) {
      const result = route.includes(resultId) ? current.operation : metadata(parentId);
      const blob = new Blob(['synthetic'], { type: 'image/png' });
      blob.width = result.artifact.width; blob.height = result.artifact.height;
      return { ok: true, headers: { get: () => '100' }, blob: async () => blob };
    }
    return { ok: true, json: async () => ({ ok: true, operation: metadata(parentId) }) };
  });
  const urls = { createObjectURL: jest.fn(blob => { const url = `blob:synthetic-${++urlIndex}`; objectBlobs.set(url, blob); return url; }),
    revokeObjectURL: jest.fn() };
  class Reader {
    readAsDataURL() { this.result = 'data:image/png;base64,c3ludGhldGlj'; Promise.resolve().then(() => this.onload()); }
  }
  class DecodedImage {
    set src(url) { const blob = objectBlobs.get(url); this.naturalWidth = blob.width; this.naturalHeight = blob.height; Promise.resolve().then(() => this.onload()); }
  }
  const window = new Element();
  window.fetch = fetch; window.confirm = jest.fn(() => true); window.ImageTextProject = engine;
  window.setTimeout = callback => callback();
  const document = { body, getElementById: id => {
    if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id);
  }, createElement: tag => {
    const value = new Element(tag);
    if (tag === 'a') value.click = () => downloads.push({ url: value.href, name: value.download });
    return value;
  } };
  vm.runInNewContext(code, { window, document, URL: urls, Blob, Image: DecodedImage, FileReader: Reader, AbortController });
  const controller = window.ImageCompare.init({ getContext: () => current, fetchImpl: fetch });
  const item = (index, name) => field('items').children[index]?.querySelectorAll('textarea,select').find(value => value.dataset.field === name);
  return { field, engine, fetch, urls, controller, window, downloads,
    setContext: value => { current = value; controller.refresh(); },
    load: () => field('load').trigger('click'), item,
    edit: (index, name, value) => { const input = item(index, name); input.value = value; field('items').trigger('input', { target: input }); },
    export: async () => { field('export').trigger('click'); return downloads.length ? JSON.parse(await objectBlobs.get(downloads.at(-1).url).text()) : null; },
    import: async value => { field('file').files = [{ size: 100, text: async () => JSON.stringify(value) }]; await field('file').trigger('change'); } };
}

test('comparison loads only canonical routes and verifies both original hashes before displaying', async () => {
  const b = browser(); await b.load();
  expect(b.fetch.mock.calls.map(([route]) => route)).toEqual([
    `/api/images/operations/${parentId}`, `/api/images/operations/${parentId}/image`, `/api/images/operations/${resultId}/image`]);
  expect(b.engine.verifySource).toHaveBeenCalledTimes(2); expect(b.field('workspace').hidden).toBe(false);
  expect(b.urls.revokeObjectURL).not.toHaveBeenCalled();
  expect(b.item(0, 'text').value).toBe('Texte exact : Maison'); expect(b.item(0, 'text').readOnly).toBe(true);
  expect(b.item(0, 'status').value).toBe('unverified');
  expect(b.fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
});

test('missing, malformed, incomplete or locked parent pairs do not launch archive reads', async () => {
  const cases = [
    { ...context(), details: { id: resultId, lineage: { version: 1, references: [] } } },
    { ...context(), details: { id: resultId, lineage: { version: 1, parent: { ...parent, operationId: '../arbitrary' } } } },
    { ...context(), operation: { ...metadata(resultId), runtimeRestored: false } },
    { ...context(), locked: true }
  ];
  for (const value of cases) { const b = browser(value); await b.load(); expect(b.fetch).not.toHaveBeenCalled(); expect(b.field('load').disabled).toBe(true); }
});

test('a parent metadata mismatch refuses before reading image bytes', async () => {
  const b = browser(); b.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true,
    operation: { ...metadata(parentId), artifact: { ...metadata(parentId).artifact, sha256: resultSha } } }) });
  await b.load(); expect(b.fetch).toHaveBeenCalledTimes(1); expect(b.field('workspace').hidden).toBe(true);
  expect(b.field('error').textContent).toContain('provenance');
});

test('a failed image hash never displays either image and cleans acquired resources', async () => {
  const b = browser(); b.engine.verifySource.mockRejectedValueOnce(new Error('Source SHA-256 does not match.'));
  await b.load(); expect(b.field('workspace').hidden).toBe(true);
  expect(b.field('parent-image').src).toBeUndefined(); expect(b.field('result-image').src).toBeUndefined();
  expect(b.urls.revokeObjectURL).toHaveBeenCalledTimes(1);
});

test('changing selection aborts a pending metadata read and prevents late display', async () => {
  const b = browser(), waiting = deferred(); b.fetch.mockReturnValueOnce(waiting.promise);
  const opening = b.load(), signal = b.fetch.mock.calls[0][1].signal;
  b.setContext({ operation: null, details: null }); expect(signal.aborted).toBe(true);
  waiting.resolve({ ok: true, json: async () => ({ ok: true, operation: metadata(parentId) }) }); await opening;
  expect(b.engine.verifySource).not.toHaveBeenCalled(); expect(b.field('workspace').hidden).toBe(true);
});

test('different image dimensions disable the slider and retain each image proportions', async () => {
  const b = browser(context(500, 250)); await b.load();
  expect(b.field('mode').options[1].disabled).toBe(true);
  b.field('mode').value = 'slider'; b.field('mode').trigger('change');
  expect(b.field('mode').value).toBe('side'); expect(b.field('slider').hidden).toBe(true);
  expect(b.field('dimensions').textContent).toContain('Dimensions différentes');
});

test('slider supports accessible percentage controls and native size without altering images', async () => {
  const b = browser(); await b.load();
  b.field('mode').value = 'slider'; b.field('mode').trigger('change');
  b.field('position').value = '25'; b.field('position').trigger('input');
  expect(b.field('slider-result').style.clipPath).toBe('inset(0 75% 0 0)');
  expect(b.field('percent').textContent).toBe('25 %');
  b.field('zoom').value = 'native'; b.field('zoom').trigger('change'); expect(b.field('stage').style.width).toBe('400px');
});

test('native views synchronize scroll progress and fit mode does not drive the other view', async () => {
  const b = browser(); await b.load(); const from = b.field('parent-scroll'), to = b.field('result-scroll');
  b.field('zoom').value = 'native'; b.field('zoom').trigger('change');
  to.scrollWidth = 1800; from.scrollLeft = 400; from.scrollTop = 300; from.trigger('scroll');
  expect(to.scrollLeft).toBe(800); expect(to.scrollTop).toBe(300);
  b.field('zoom').value = 'fit'; b.field('zoom').trigger('change'); from.scrollLeft = 100; from.trigger('scroll');
  expect(to.scrollLeft).toBe(0);
});

test('manual review exports its provenance, exact constraint and explicit user observations', async () => {
  const b = browser(); await b.load(); b.edit(0, 'status', 'difference'); b.edit(0, 'note', 'Le titre visible est différent.');
  const review = await b.export();
  expect(review).toMatchObject({ schema: 'agentx.image-review.v1', mode: 'manual', pair: {
    parent, result: { operationId: resultId, sha256: resultSha, width: 400, height: 200 } } });
  expect(review.items[0]).toMatchObject({ text: 'Texte exact : Maison', sourceItemId: 'exact-1', status: 'difference', note: 'Le titre visible est différent.' });
  expect(b.field('review-status').textContent).toContain('1 écarts observés'); expect(b.field('review-status').textContent).not.toContain('à enregistrer');
});

test('manual observations survive switching selection and returning to the same verified archives', async () => {
  const b = browser(); await b.load(); b.edit(0, 'note', 'À conserver en revenant.');
  b.setContext({ operation: metadata(parentId), details: { id: parentId } }); expect(b.field('workspace').hidden).toBe(true);
  b.setContext(context()); await b.load(); expect(b.item(0, 'note').value).toBe('À conserver en revenant.');
  expect(b.field('review-status').textContent).toContain('à enregistrer');
});

test('reopening a matching review restores manual status without any new API requests', async () => {
  const b = browser(); await b.load(); const review = await b.export(), reads = b.fetch.mock.calls.length;
  review.items[0].status = 'confirmed'; review.items[0].note = 'Examiné manuellement.';
  await b.import(review); expect(b.item(0, 'status').value).toBe('confirmed');
  expect(b.fetch).toHaveBeenCalledTimes(reads);
});

test('a review for another archive or a changed recorded constraint never replaces current observations', async () => {
  const b = browser(); await b.load(); b.edit(0, 'note', 'Mon observation'); const review = await b.export();
  await b.import({ ...review, pair: { ...review.pair, result: { ...review.pair.result, sha256: sha } } });
  expect(b.field('error').textContent).toContain('Choisis'); expect(b.item(0, 'note').value).toBe('Mon observation');
  await b.import({ ...review, items: [{ ...review.items[0], text: 'Autre contrainte' }] });
  expect(b.field('error').textContent).toContain('contrainte enregistrée'); expect(b.item(0, 'note').value).toBe('Mon observation');
});

test('declining replacement preserves dirty notes and an invalid field cannot be exported', async () => {
  const b = browser(); await b.load(); b.edit(0, 'note', 'Mon observation');
  const fileRead = jest.fn(async () => '{}'); b.field('file').files = [{ size: 2, text: fileRead }];
  b.window.confirm.mockReturnValue(false); await b.field('file').trigger('change');
  expect(fileRead).not.toHaveBeenCalled(); expect(b.item(0, 'note').value).toBe('Mon observation');
  b.edit(0, 'note', 'x'.repeat(1001)); expect(b.field('export').disabled).toBe(true);
  expect(await b.export()).toBeNull(); expect(b.downloads).toHaveLength(0);
});

test('stale imports do not attach observations to a changed selection', async () => {
  const b = browser(); await b.load(); const review = await b.export(), waiting = deferred();
  b.field('file').files = [{ size: 100, text: () => waiting.promise }]; const importing = b.field('file').trigger('change');
  b.setContext({ operation: null, details: null }); waiting.resolve(JSON.stringify(review)); await importing;
  expect(b.field('workspace').hidden).toBe(true); expect(b.field('file').disabled).toBe(true);
});

test('oversized import files are refused before parsing and displayed object URLs are released on destroy', async () => {
  const b = browser(); await b.load(); const read = jest.fn();
  b.field('file').files = [{ size: 200001, text: read }]; await b.field('file').trigger('change');
  expect(read).not.toHaveBeenCalled(); expect(b.field('error').textContent).toContain('taille autorisée');
  b.controller.destroy(); expect(b.urls.revokeObjectURL).toHaveBeenCalledTimes(2);
});
