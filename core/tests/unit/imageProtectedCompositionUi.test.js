'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../../public/js/image-protected-composition.js'), 'utf8');
const parentId = '11111111-1111-4111-8111-111111111111', resultId = '22222222-2222-4222-8222-222222222222';
const parentSha = 'a'.repeat(64), resultSha = 'b'.repeat(64), outputSha = 'c'.repeat(64), outsideSha = 'd'.repeat(64);
function context() {
  return { locked: false, operation: { id: resultId, state: 'completed', runtimeRestored: true,
    artifact: { sha256: resultSha, width: 400, height: 200, url: 'https://untrusted.invalid/result' } },
  details: { id: resultId, lineage: { version: 1, parent: { operationId: parentId, sha256: parentSha, width: 400, height: 200 } } } };
}
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.hidden = false; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children.length = 0; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  removeEventListener(type) { delete this.listeners[type]; }
  trigger(type, event) { return this.listeners[type]?.(event); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  getBoundingClientRect() { return { left: 10, top: 20, width: 200, height: 100 }; }
  setPointerCapture() {}
}
function receipt(regions) {
  const pixels = new Set();
  for (const region of regions) for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) pixels.add(y * 400 + x);
  }
  return { schema: 'agentx.protected-image-composition/v1', parent: { operationId: parentId, sha256: parentSha },
    result: { operationId: resultId, sha256: resultSha }, width: 400, height: 200, regions,
    proof: { contract: 'decoded-rgba-row-major-outside-rectangle-union/v1', decoder: 'pngjs-7.0.0/jpeg-js-0.4.4',
      verified: true, protectedPixels: 80000 - pixels.size, selectedPixels: pixels.size,
      outsideRgbaSha256: outsideSha, outputSha256: outputSha } };
}
function browser(initial = context()) {
  let current = initial, sequence = 0, mutateReceipt = value => value;
  const fields = new Map(), objectBlobs = new Map(), requests = [];
  const field = name => { const id = `image-protected-${name}`; if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id); };
  ['x', 'y', 'width', 'height'].forEach(name => { field(name).value = ['x', 'y'].includes(name) ? '0' : '1'; });
  const canvasContext = { drawImage: jest.fn(), fillRect: jest.fn(), strokeRect: jest.fn() };
  field('canvas').getContext = () => canvasContext;
  const engine = { create: jest.fn(source => ({ source })), verifySource: jest.fn(async () => ({})) };
  const fetch = jest.fn(async (route, options) => {
    if (route.endsWith('/protected-composition')) {
      const payload = JSON.parse(options.body); requests.push(payload);
      return { ok: true, json: async () => ({ ok: true, receipt: mutateReceipt(receipt(payload.regions)), png: 'c3ludGhldGlj' }) };
    }
    return { ok: true, blob: async () => new Blob(['source'], { type: 'image/png' }) };
  });
  const urls = { createObjectURL: jest.fn(blob => { const url = `blob:composition-${++sequence}`; objectBlobs.set(url, blob); return url; }), revokeObjectURL: jest.fn() };
  class Reader { readAsDataURL() { this.result = 'data:image/png;base64,c291cmNl'; Promise.resolve().then(() => this.onload()); } }
  const dimensions = { width: 400, height: 200 };
  class Image {
    constructor() { this.naturalWidth = dimensions.width; this.naturalHeight = dimensions.height; }
    async decode() {}
  }
  const globals = { document: { getElementById: id => {
    if (!fields.has(id)) fields.set(id, new Element()); return fields.get(id);
  }, createElement: tag => new Element(tag), createTextNode: value => { const text = new Element('text'); text.textContent = value; return text; } },
    fetch, ImageTextProject: engine, Image, FileReader: Reader, Blob, URL: urls, AbortController, Uint8Array,
    atob: value => Buffer.from(value, 'base64').toString('binary'), Intl };
  vm.runInNewContext(code, globals);
  const controller = globals.ImageProtectedComposition.init({ getContext: () => current, fetchImpl: fetch });
  return { field, fetch, requests, engine, urls, controller, dimensions, canvasContext,
    setContext: value => { current = value; controller.refresh(); },
    mutate: handler => { mutateReceipt = handler; },
    prepare: async () => { field('prepare').trigger('click'); await settle(); },
    build: async () => { field('build').trigger('click'); await settle(); },
    add: (x = 0, y = 0, width = 1, height = 1) => {
      for (const [name, value] of Object.entries({ x, y, width, height })) field(name).value = String(value);
      field('add').trigger('click');
    },
    savedReceipt: async () => JSON.parse(await objectBlobs.get(field('receipt').href).text()) };
}

test('the exact archived parent uses a canonical path and SHA verification before drawing', async () => {
  const b = browser(); await b.prepare();
  expect(b.fetch).toHaveBeenCalledWith(`/api/images/operations/${parentId}/image`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(b.engine.create.mock.calls[0][0]).toMatchObject({ operationId: parentId, sha256: parentSha, width: 400, height: 200 });
  expect(b.engine.verifySource).toHaveBeenCalledTimes(1); expect(b.field('workspace').hidden).toBe(false);
  expect(b.field('canvas').width).toBe(400); expect(b.field('canvas').height).toBe(200);
});

test('drawing converts the responsive display coordinates to integer native pixels', async () => {
  const b = browser(); await b.prepare();
  b.field('canvas').trigger('pointerdown', { button: 0, pointerId: 1, clientX: 60, clientY: 45 });
  b.field('canvas').trigger('pointerup', { pointerId: 1, clientX: 160, clientY: 95 });
  await b.build(); expect(b.requests[0].regions).toEqual([{ x: 100, y: 50, width: 200, height: 100 }]);
  expect(b.fetch.mock.calls.at(-1)[0]).toBe(`/api/images/operations/${resultId}/protected-composition`);
  expect(b.requests[0]).toMatchObject({ parentSha256: parentSha, resultSha256: resultSha });
  expect(b.engine.create.mock.calls.at(-1)[0]).toMatchObject({ sha256: outputSha, width: 400, height: 200 });
  expect(b.field('downloads').hidden).toBe(false); expect((await b.savedReceipt()).proof.protectedPixels).toBe(60000);
});

test('pointer cancellation and zero-area drawings do not add a region', async () => {
  const b = browser(); await b.prepare();
  b.field('canvas').trigger('pointerdown', { button: 0, pointerId: 1, clientX: 60, clientY: 45 });
  b.field('canvas').trigger('pointercancel', {});
  b.field('canvas').trigger('pointerup', { pointerId: 1, clientX: 160, clientY: 95 });
  b.field('canvas').trigger('pointerdown', { button: 0, pointerId: 1, clientX: 60, clientY: 45 });
  b.field('canvas').trigger('pointerup', { pointerId: 1, clientX: 60, clientY: 45 });
  await b.build(); expect(b.requests).toHaveLength(0); expect(b.field('build').disabled).toBe(true);
});

test.each([[-1, 0, 1, 1], [0, 0, 0, 1], [0, 0, 1.5, 1], [400, 0, 1, 1], ['', 0, 1, 1]])(
  'invalid region %j never enters the selected replacement list', async (...values) => {
    const b = browser(); await b.prepare(); b.add(...values); await b.build();
    expect(b.requests).toHaveLength(0); expect(b.field('regions').children).toHaveLength(0);
  }
);

test('a failed new region preserves the previously validated regions and is never sent', async () => {
  const b = browser(); await b.prepare(); b.add(0, 0, 10, 10); b.add(400, 0, 10, 10); await b.build();
  expect(b.requests[0].regions).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
});

test('selection and lock changes invalidate pending preparations and late decoded images', async () => {
  const b = browser(), waiting = deferred(); b.engine.verifySource.mockReturnValueOnce(waiting.promise);
  await b.prepare(); const signal = b.fetch.mock.calls[0][1].signal;
  b.setContext({ ...context(), locked: true }); expect(signal.aborted).toBe(true);
  waiting.resolve({}); await settle(); expect(b.field('workspace').hidden).toBe(true);
  expect(b.canvasContext.drawImage).not.toHaveBeenCalled();
});

test('a pending build discarded by selection change or destroy cannot publish downloads', async () => {
  for (const action of ['selection', 'destroy']) {
    const b = browser(), waiting = deferred(); await b.prepare(); b.add();
    b.fetch.mockResolvedValueOnce({ ok: true, json: () => waiting.promise }); await b.build();
    const signal = b.fetch.mock.calls.at(-1)[1].signal;
    if (action === 'selection') b.setContext({ operation: null, details: null }); else b.controller.destroy();
    expect(signal.aborted).toBe(true); waiting.resolve({ ok: true, receipt: receipt([{ x: 0, y: 0, width: 1, height: 1 }]), png: 'c3ludGhldGlj' }); await settle();
    expect(b.urls.createObjectURL).not.toHaveBeenCalled(); expect(b.field('downloads').hidden).toBe(true);
  }
});

test('HTTP errors and corrupted output hashes cannot expose a result or leave the build stuck', async () => {
  const b = browser(); await b.prepare(); b.add();
  b.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, message: 'Archive incohérente.' }) });
  await b.build(); expect(b.field('downloads').hidden).toBe(true); expect(b.field('build').disabled).toBe(false);
  b.engine.verifySource.mockRejectedValueOnce(new Error('Source SHA-256 does not match.'));
  await b.build(); expect(b.urls.createObjectURL).not.toHaveBeenCalled(); expect(b.field('downloads').hidden).toBe(true);
});

test.each(['parent-id', 'parent-sha', 'result-id', 'result-sha', 'regions', 'unverified', 'schema'])('%s receipt mismatch drops the result', async mismatch => {
  const b = browser(); await b.prepare(); b.add();
  b.mutate(value => {
    if (mismatch === 'parent-id') value.parent.operationId = resultId;
    if (mismatch === 'parent-sha') value.parent.sha256 = resultSha;
    if (mismatch === 'result-id') value.result.operationId = parentId;
    if (mismatch === 'result-sha') value.result.sha256 = parentSha;
    if (mismatch === 'regions') value.regions = [];
    if (mismatch === 'unverified') value.proof.verified = false;
    if (mismatch === 'schema') value.schema = 'unsupported';
    return value;
  });
  await b.build(); expect(b.urls.createObjectURL).not.toHaveBeenCalled(); expect(b.field('downloads').hidden).toBe(true);
});

test('changing replacement regions revokes completed downloads and cache returns only for the original pair', async () => {
  const b = browser(); await b.prepare(); b.add(); await b.build();
  b.add(2, 2, 1, 1); expect(b.field('downloads').hidden).toBe(true); expect(b.urls.revokeObjectURL).toHaveBeenCalledTimes(2);
  b.setContext({ ...context(), locked: true }); b.setContext(context()); await b.prepare();
  expect(b.field('regions').children).toHaveLength(2);
});

// Independent-review regressions: the controller must tie the displayed parent
// to the selected operation and validate the complete proof before publishing it.
test.each(['wrong-details', 'unsupported-lineage'])('%s cannot enable or prepare a protected composition', async mismatch => {
  const value = context();
  if (mismatch === 'wrong-details') value.details.id = parentId; else value.details.lineage.version = 2;
  const b = browser(value); expect(b.field('prepare').disabled).toBe(true); await b.prepare();
  expect(b.fetch).not.toHaveBeenCalled();
});

test('changed dimensions invalidate the previously prepared canvas and region selection', async () => {
  const b = browser(); await b.prepare(); b.add(); const value = context();
  value.operation.artifact.width = value.details.lineage.parent.width = 500;
  b.setContext(value); expect(b.field('workspace').hidden).toBe(true); expect(b.field('build').disabled).toBe(true);
});

test('destroy invalidates a late parent decode and refresh cannot revive the disposed panel', async () => {
  const b = browser(), waiting = deferred(); b.engine.verifySource.mockReturnValueOnce(waiting.promise);
  await b.prepare(); b.controller.destroy(); b.controller.refresh();
  waiting.resolve({}); await settle();
  expect(b.field('workspace').hidden).toBe(true); expect(b.canvasContext.drawImage).not.toHaveBeenCalled();
  expect(b.field('prepare').listeners.click).toBeUndefined();
});

test('browser decoding dimensions must match the verified image descriptor before drawing', async () => {
  const b = browser(); b.dimensions.width = 200; b.dimensions.height = 400; await b.prepare();
  expect(b.field('workspace').hidden).toBe(true); expect(b.canvasContext.drawImage).not.toHaveBeenCalled();
});

test.each(['width', 'height', 'contract', 'negative-count', 'wrong-total', 'outside-hash'])('%s proof mismatch cannot be downloaded', async mismatch => {
  const b = browser(); await b.prepare(); b.add();
  b.mutate(value => {
    if (mismatch === 'width') value.width++;
    if (mismatch === 'height') value.height++;
    if (mismatch === 'contract') value.proof.contract = 'unsupported';
    if (mismatch === 'negative-count') value.proof.protectedPixels = -1;
    if (mismatch === 'wrong-total') value.proof.selectedPixels = 50;
    if (mismatch === 'outside-hash') value.proof.outsideRgbaSha256 = 'not-a-hash';
    return value;
  });
  await b.build(); expect(b.urls.createObjectURL).not.toHaveBeenCalled(); expect(b.field('downloads').hidden).toBe(true);
});
