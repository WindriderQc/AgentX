'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../../public/image-lab/lab-resources/ready/intents.js'), 'utf8');
const evidence = { id: 'scenes', sha256: 'a'.repeat(64), entries: [
  { id: 'first', kind: 'record', title: 'First', width: 1024, height: 1024, prompt: 'A scene', parameters: { seed: 42, steps: 25, denoise: 1 }, declaredParentSha256: [], operation: 'text_to_image' },
  { id: 'second', kind: 'record', title: 'Second', width: 2048, height: 2048, prompt: 'Another scene', parameters: { seed: 7, steps: 40, denoise: 1 }, declaredParentSha256: [], operation: 'text_to_image' }
] };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = result => ({ ok: true, json: async () => result });
function browser() {
  let form;
  function draw() {
    if (form) form.isConnected = false;
    const listeners = {}, fields = {};
    for (const name of ['catalogue', 'entry', 'width', 'height', 'seed', 'prompt', 'approved', 'status', 'evidence', 'export']) {
      fields[name] = { id: 'intent-' + name, value: '', disabled: false, textContent: '' };
      Object.defineProperty(fields[name], 'innerHTML', { set() { fields[name].value = ''; } });
    }
    form = { isConnected: true, fields, querySelector: selector => fields[selector.replace('#intent-', '')],
      addEventListener: (type, handler) => { listeners[type] = handler; },
      input: (name, value) => { fields[name].value = value; listeners.input({ type: 'input', target: fields[name] }); },
      change: name => { const result = fields[name].onchange?.(); listeners.change({ type: 'change', target: fields[name] }); return result; }
    };
    return form;
  }
  const download = jest.fn(), fetch = jest.fn(async () => response({ catalogue: evidence }));
  const context = { window: {}, document: { querySelector: () => form, createElement: () => ({ click: download }) }, fetch,
    Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: jest.fn() }, setTimeout: () => {} };
  vm.runInNewContext(code, context);
  return { draw, fetch, download, ui: context.window.ImageLabIntents };
}
async function select(b) {
  const form = b.draw(); await b.ui.bind(); form.fields.catalogue.value = 'scenes'; await form.change('catalogue');
  expect(form.fields.export.disabled).toBe(true); form.fields.entry.value = '0'; await form.change('entry'); return form;
}
test('changing variants updates evidence and untouched dimensions while preserving an edited brief and seed', async () => {
  const b = browser(), form = await select(b);
  form.input('prompt', 'Keep my exact brief'); form.input('seed', '1729');
  form.fields.entry.value = '1'; await form.change('entry');
  expect(form.fields.prompt.value).toBe('Keep my exact brief'); expect(form.fields.seed.value).toBe('1729');
  expect(form.fields.width.value).toBe(2048); expect(form.fields.evidence.textContent).toContain('40 étapes');
});
test('a selection changed during export cannot download an old plan or permit simultaneous export', async () => {
  const b = browser(), form = await select(b), waiting = deferred(); b.fetch.mockReturnValueOnce(waiting.promise);
  const exportPromise = form.onsubmit({ preventDefault() {} });
  form.fields.entry.value = '1'; await form.change('entry'); expect(form.fields.export.disabled).toBe(true);
  waiting.resolve(response({ id: 'old-intent' })); await exportPromise;
  expect(b.download).not.toHaveBeenCalled(); expect(form.fields.status.textContent).toContain('Choix modifié');
  expect(form.fields.export.disabled).toBe(false);
});
test('a detached form cannot download a completed old export', async () => {
  const b = browser(), form = await select(b), waiting = deferred(); b.fetch.mockReturnValueOnce(waiting.promise);
  const exportPromise = form.onsubmit({ preventDefault() {} }); b.draw();
  waiting.resolve(response({ id: 'old-intent' })); await exportPromise; expect(b.download).not.toHaveBeenCalled();
});
test('a changed catalogue keeps the whole request draft but requires a fresh recipe selection', async () => {
  const b = browser(), form = await select(b);
  form.input('prompt', 'Keep this brief'); form.input('approved', 'Keep the jar'); form.input('width', '4096');
  const next = b.draw(); b.fetch.mockResolvedValueOnce(response({ catalogue: { ...evidence, sha256: 'b'.repeat(64) } })); await b.ui.bind();
  expect(next.fields.entry.value).toBe(''); expect(next.fields.export.disabled).toBe(true);
  expect(next.fields.prompt.value).toBe('Keep this brief'); expect(next.fields.approved.value).toBe('Keep the jar');
  expect(next.fields.width.value).toBe('4096'); expect(next.fields.status.textContent).toContain('recettes ont changé');
  next.fields.entry.value = '1'; await next.change('entry'); expect(next.fields.prompt.value).toBe('Keep this brief');
  expect(next.fields.width.value).toBe('4096');
});
test('editing a restored draft while catalogue fetch is pending is never overwritten by its late response', async () => {
  const b = browser(), form = await select(b); form.input('prompt', 'Earlier draft');
  const next = b.draw(), waiting = deferred(); b.fetch.mockReturnValueOnce(waiting.promise); const binding = b.ui.bind();
  next.input('prompt', 'Newer edit'); waiting.resolve(response({ catalogue: evidence })); await binding;
  expect(next.fields.prompt.value).toBe('Newer edit'); expect(next.fields.entry.value).toBe('0');
});
