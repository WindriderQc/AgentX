'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../public/plant-import'), 'utf8'), { window });
const { html, mount } = window.PlantImport;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const hash = 'a'.repeat(64);
const entry = { name: 'salon-1.jpg', state: 'available', sha256: hash, roomHint: 'Salon' };
const result = entries => ({ configured: true, entries, nextOffset: null });

test('list has disabled, empty and supported/unsupported/imported states without leaking raw filenames into HTML', () => {
  assert.match(html({ configured: false }, esc), /n’est pas configuré/);
  assert.match(html(result([]), esc), /Aucune photo/);
  const output = html(result([entry, { name: '<img>.heic', state: 'unsupported', message: 'HEIC : convertir en JPEG' },
    { ...entry, name: 'imported.png', state: 'imported', plantId: 'p1' }, { ...entry, state: 'incomplete', plantId: 'p2' }]), esc);
  assert.match(output, /thumbnail\?name=salon-1.jpg&amp;sha256=/);
  assert.match(output, /&lt;img&gt;.heic/); assert.match(output, /convertir en JPEG/);
  assert.match(output, /Déjà importée/); assert.match(output, /Import à reprendre/);
  assert.match(output, /\?plant=p1/);
  assert.equal((output.match(/type="checkbox"/g) || []).length, 2);
  assert.doesNotMatch(output, /<img>.heic/);
});

test('bounded folder and pagination are visible', () => {
  const output = html({ ...result([entry]), truncated: true, nextOffset: 20 }, esc);
  assert.match(output, /500 premières entrées/); assert.match(output, /data-import-next="20"/);
});

function fakeHost() {
  const controls = [{ disabled: false }, { disabled: false }];
  const status = {}, selection = [{ value: hash, dataset: { name: entry.name, room: 'Salon' } }];
  const form = { elements: { nickname: { value: 'Synthetic plant' }, room: { value: '' } },
    querySelector: () => selection[0], querySelectorAll: () => selection };
  const nodes = { '[data-import-form]': form, '[data-import-status]': status,
    '[data-import-selection]': {}, '[data-import-back]': {}, '[data-import-reload]': {}, '[data-import-more]': {} };
  return { innerHTML: '', querySelector: selector => nodes[selector] || null, querySelectorAll: () => controls, form, status, controls };
}

test('load failure offers retry and a way back', async () => {
  const host = fakeHost();
  await mount({ host, api: async () => { throw new Error('Synthetic unavailable <error>'); }, esc, onDone() {} });
  assert.match(host.innerHTML, /role="alert"/); assert.match(host.innerHTML, /Synthetic unavailable &lt;error&gt;/);
  assert.equal(typeof host.querySelector('[data-import-reload]').onclick, 'function');
  assert.equal(typeof host.querySelector('[data-import-back]').onclick, 'function');
});

test('selects a room hint, keeps the same body after a lost response and opens the parent draft', async () => {
  const host = fakeHost(), calls = [];
  let attempts = 0;
  const api = async (url, options) => {
    if (!options) return result([entry]);
    calls.push(JSON.parse(options.body));
    if (attempts++ === 0) throw new Error('Synthetic response lost');
    return { plant: { id: 'synthetic-draft' }, planningError: null };
  };
  await mount({ host, api, esc, onDone() {} });
  assert.match(host.innerHTML, /enfants voient uniquement les fiches publiées/);
  host.form.querySelectorAll()[0].checked = true; host.form.onchange(); assert.equal(host.form.elements.room.value, 'Salon');
  await host.form.onsubmit({ preventDefault() {} });
  assert.match(host.status.textContent, /réessayer la même sélection/);
  assert.ok(host.controls.every(control => !control.disabled));
  // An uncertain response does not replace the submitted intent on retry.
  host.form.elements.nickname.value = 'Unsubmitted value';
  await host.form.onsubmit({ preventDefault() {} });
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0].files, [{ name: 'salon-1.jpg', sha256: hash }]);
  assert.match(host.innerHTML, /Identification dans la file Core/);
  assert.match(host.innerHTML, /\?plant=synthetic-draft/);
});

test('a planning failure says the draft exists and is waiting for Core', async () => {
  const host = fakeHost();
  await mount({ host, api: async (_url, options) => options ? { plant: { id: 'p1' }, planningError: 'PLANT_VISION_UNAVAILABLE' } : result([entry]), esc, onDone() {} });
  host.form.querySelectorAll()[0].checked = true; host.form.onchange();
  await host.form.onsubmit({ preventDefault() {} });
  assert.match(host.innerHTML, /Brouillon créé/); assert.match(host.innerHTML, /attend la configuration/);
});

test('photos from different pages remain grouped in one request', async () => {
  const host = fakeHost(), photos = host.form.querySelectorAll();
  const next = { addEventListener(_event, listener) { this.click = listener; }, dataset: { importNext: '20' } };
  const previous = { addEventListener(_event, listener) { this.click = listener; } };
  const query = host.querySelector;
  host.querySelector = selector => selector === '[data-import-next]' ? next : selector === '[data-import-previous]' ? previous : query(selector);
  const calls = [];
  const api = async (url, options) => {
    if (options) { calls.push(JSON.parse(options.body)); return { plant: { id: 'grouped' } }; }
    if (url.endsWith('offset=20')) {
      photos.splice(0, photos.length, { value: 'b'.repeat(64), dataset: { name: 'leaf.webp', room: 'Salon' }, checked: false });
      return result([{ ...entry, name: 'leaf.webp', sha256: 'b'.repeat(64) }]);
    }
    return { ...result([entry]), nextOffset: 20 };
  };
  await mount({ host, api, esc, onDone() {} });
  photos[0].checked = true; host.form.onchange();
  next.click({ currentTarget: next });
  await new Promise(resolve => setImmediate(resolve));
  photos[0].checked = true; host.form.onchange();
  await host.form.onsubmit({ preventDefault() {} });
  assert.deepEqual(calls[0].files.map(file => file.name), ['salon-1.jpg', 'leaf.webp']);
});
