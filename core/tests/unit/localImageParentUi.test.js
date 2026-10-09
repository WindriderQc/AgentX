'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/local-images.js'), 'utf8');
const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const checksum = 'a'.repeat(64);
const archived = id => ({ id, state: 'completed', runtimeRestored: true, profile: 'quality', label: 'Fixture',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  artifact: { sha256: checksum, width: 1024, height: 1024, url: `/api/images/operations/${id}/image` } });

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.files = []; }
  get options() { return this.children; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  dispatchEvent(event) { return Promise.all((this.listeners[event.type] || []).map(handler => handler(event))); }
  querySelectorAll(tag) { return this.children.flatMap(child => [
    ...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag) ]); }
  focus() {}
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function studio({ failFirst = false, lineage, requested = parentId, availableRecipe, historicalRecipe, execution, exportFailure, exportPending } = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const size = new Element('option'); size.value = '1024,1024'; size.textContent = 'Square';
  get('image-size').append(size); get('image-size').value = size.value;
  get('image-prompt').value = 'Edit the chosen scene'; get('image-seed').value = '';
  const post = [], canvas = jest.fn(), imageDecode = jest.fn(); let sequence = 0;
  get('image-form').reset = () => { get('image-prompt').value = ''; get('image-seed').value = ''; get('image-references').files = []; };
  const detail = id => ({ id, recipe: { id: 'quality', label: 'Fixture', steps: 4, ...(historicalRecipe && { declaredIdentity: historicalRecipe }) }, ...(execution && { execution }),
    request: { prompt: 'Edit the chosen scene', seed: 42, width: 1024, height: 1024 }, ...(lineage && { lineage }) });
  const fetch = jest.fn(async (url, options) => {
    let data;
    if (options.method === 'POST') {
      post.push(JSON.parse(options.body));
      if (failFirst && post.length === 1) return { ok: false, json: async () => ({ ok: false, message: 'Fixture connection interrupted' }) };
      data = { operation: archived(childId) };
    } else if (url.endsWith('/export')) {
      if (exportPending) await exportPending;
      if (exportFailure) return { ok: false, json: async () => ({ message: exportFailure }) };
      return { ok: true, json: async () => ({ schemaVersion: 1, parts: [{ name: 'graph.json' }, { name: 'reference-0-source.jpg' }, { name: 'output.png' }] }) };
    } else if (url.endsWith('/status')) data = { configured: true, defaultProfile: 'quality', profiles: [{ id: 'quality', label: 'Fixture', maxPixels: 4194304 }] };
    else if (url.endsWith('/workshop')) data = { profiles: [{ id: 'quality', label: 'Fixture', steps: 4, maxPixels: 4194304, ...(availableRecipe && { declaredIdentity: availableRecipe }) }], worker: null };
    else if (url.endsWith('/draft')) data = { draft: { profile: 'quality', prompt: 'Edit the chosen scene', width: 1024, height: 1024, seed: 42 } };
    else if (url.endsWith('/details')) data = { details: detail(requested) };
    else if (url.endsWith('/operations')) data = { operations: [archived(parentId)] };
    else data = { operation: archived(requested) };
    return { ok: true, json: async () => ({ ok: true, ...data }) };
  });
  vm.runInNewContext(source, { document: { getElementById: get, createElement: tag => {
    const el = new Element(tag);
    if (tag === 'canvas') { canvas(); el.getContext = () => ({ drawImage() {} }); el.toDataURL = () => 'data:image/jpeg;base64,bWFudWFs'; }
    return el;
  } }, fetch, Intl, Date, URLSearchParams, location: { search: `?operation=${requested}` },
  localStorage: { setItem() {} }, crypto: { randomUUID: () => `fixture-action-${++sequence}` },
  URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
  Image: class { constructor() { this.width = 2; this.height = 2; } async decode() { imageDecode(); } },
  Event: class { constructor(type) { this.type = type; } }, setTimeout: jest.fn(), clearTimeout: jest.fn() });
  await settle();
  const fire = async (id, type = 'click') => { await get(id).dispatchEvent({ type, preventDefault() {} }); await settle(); };
  return { get, fire, post, canvas, imageDecode, fetch };
}

test('the chosen archive sends its exact parent identity without converting the browser preview', async () => {
  const ui = await studio(); await ui.fire('image-use-reference'); await ui.fire('image-form', 'submit');
  expect(ui.post).toHaveLength(1);
  expect(ui.post[0]).toMatchObject({ parent: { operationId: parentId, sha256: checksum }, references: [] });
  expect(ui.canvas).not.toHaveBeenCalled(); expect(ui.imageDecode).not.toHaveBeenCalled();
});
test('an interrupted POST retains the chosen parent and exact action identity on retry', async () => {
  const ui = await studio({ failFirst: true }); await ui.fire('image-use-reference');
  await ui.fire('image-form', 'submit'); await ui.fire('image-form', 'submit');
  expect(ui.post).toHaveLength(2); expect(ui.post[1]).toEqual(ui.post[0]);
  expect(ui.post[1].parent).toEqual({ operationId: parentId, sha256: checksum });
});
test('one manually uploaded working copy accompanies the chosen parent separately', async () => {
  const ui = await studio(); await ui.fire('image-use-reference');
  ui.get('image-references').files = [{ type: 'image/png', name: 'fixture.png' }];
  await ui.fire('image-form', 'submit');
  expect(ui.post[0]).toMatchObject({ parent: { operationId: parentId, sha256: checksum }, references: ['bWFudWFs'] });
  expect(ui.canvas).toHaveBeenCalledTimes(1); expect(ui.imageDecode).toHaveBeenCalledTimes(1);
});
test('two uploaded files with a chosen parent refuse before POST', async () => {
  const ui = await studio(); await ui.fire('image-use-reference');
  ui.get('image-references').files = [{ type: 'image/png' }, { type: 'image/png' }];
  await ui.fire('image-form', 'submit'); expect(ui.post).toHaveLength(0);
  expect(ui.get('image-status').textContent).toContain('Deux références');
});
test('starting a new brief clears the archived parent', async () => {
  const ui = await studio(); await ui.fire('image-use-reference'); await ui.fire('image-new');
  ui.get('image-prompt').value = 'A new scene'; await ui.fire('image-form', 'submit');
  expect(ui.post[0].parent).toBeUndefined(); expect(ui.post[0].references).toEqual([]);
});
test('historical child details show the recorded parent link and archive preview', async () => {
  const ui = await studio({ requested: childId, lineage: { version: 1, parent: { operationId: parentId, sha256: checksum, width: 512, height: 512 } } });
  await settle();
  const details = ui.get('image-saved-recipe');
  expect(details.querySelectorAll('a').map(node => node.href)).toContain(`/images?operation=${parentId}`);
  expect(details.querySelectorAll('img').map(node => node.src)).toContain(`/api/images/operations/${parentId}/image`);
  expect(ui.post).toHaveLength(0);
});
test('manual-only lineage renders details without an invented parent link', async () => {
  const ui = await studio({ requested: childId, lineage: { version: 1, references: [{ sourceSha256: checksum, workerSha256: checksum }] } });
  await settle();
  expect(ui.get('image-result-details').hidden).toBe(false);
  expect(ui.get('image-saved-recipe').querySelectorAll('a')).toHaveLength(0);
  expect(ui.get('image-saved-recipe').querySelectorAll('img')).toHaveLength(0);
  expect(ui.post).toHaveLength(0);
});

test('a declared recipe uses the available pair and preserves it across an interrupted retry', async () => {
  const ui = await studio({ availableRecipe: { id: 'current-recipe', version: '2' }, failFirst: true });
  await ui.fire('image-form', 'submit'); await ui.fire('image-form', 'submit');
  expect(ui.post).toHaveLength(2);
  expect(ui.post[0]).toMatchObject({ recipeId: 'current-recipe', recipeVersion: '2' });
  expect(ui.post[1]).toEqual(ui.post[0]);
});
test('profiles without a declared recipe preserve legacy request fields', async () => {
  const ui = await studio(); await ui.fire('image-form', 'submit');
  expect(ui.post).toHaveLength(1);
  expect(ui.post[0].recipeId).toBeUndefined(); expect(ui.post[0].recipeVersion).toBeUndefined();
});
test('historical recipe facts retain their saved pair and prepared graph digest', async () => {
  const ui = await studio({ availableRecipe: { id: 'current-recipe', version: '2' },
    historicalRecipe: { id: 'saved-recipe', version: '1' }, execution: { graphSha256: checksum } });
  await settle();
  const values = ui.get('image-saved-recipe').querySelectorAll('dd').map(el => el.textContent);
  expect(values).toContain('saved-recipe'); expect(values).toContain('1'); expect(values).toContain(checksum);
  expect(values).not.toContain('current-recipe'); expect(values).not.toContain('2');
  expect(ui.post).toHaveLength(0);
});
test('old details do not invent historical recipe or graph facts from the current profile', async () => {
  const ui = await studio({ availableRecipe: { id: 'current-recipe', version: '2' } }); await settle();
  const labels = ui.get('image-saved-recipe').querySelectorAll('dt').map(el => el.textContent);
  expect(labels).not.toContain('Recette enregistrée'); expect(labels).not.toContain('Version enregistrée');
  expect(labels).not.toContain('Graphe préparé (SHA-256)'); expect(ui.post).toHaveLength(0);
});

test('an archive export requires a manual click and downloads historical pieces without a POST', async () => {
  const ui = await studio();
  expect(ui.fetch.mock.calls.some(([url]) => url.endsWith('/export'))).toBe(false);
  expect(ui.get('image-export').hidden).toBe(false);
  await ui.fire('image-export-prepare');
  const links = ui.get('image-export-links').querySelectorAll('a');
  expect(links.map(link => link.download)).toEqual(['image-recipe.json', 'graph.json', 'reference-0-source.jpg', 'output.png']);
  expect(links.map(link => link.href)).toContain(`/api/images/operations/${parentId}/export/parts/graph.json`);
  expect(ui.post).toHaveLength(0); expect(ui.canvas).not.toHaveBeenCalled();
});
test('a refused export leaves no fabricated download links', async () => {
  const ui = await studio({ exportFailure: 'Historical references unavailable' });
  await ui.fire('image-export-prepare');
  expect(ui.get('image-export-status').textContent).toBe('Historical references unavailable');
  expect(ui.get('image-export-links').querySelectorAll('a')).toHaveLength(0);
  expect(ui.get('image-export-prepare').disabled).toBe(false); expect(ui.post).toHaveLength(0);
});
test('leaving an image while its export is pending discards stale download links', async () => {
  let release; const exportPending = new Promise(resolve => { release = resolve; });
  const ui = await studio({ exportPending });
  await ui.fire('image-export-prepare'); await ui.fire('image-new'); release(); await settle();
  expect(ui.get('image-export').hidden).toBe(true);
  expect(ui.get('image-export-links').querySelectorAll('a')).toHaveLength(0);
  expect(ui.post).toHaveLength(0);
});
