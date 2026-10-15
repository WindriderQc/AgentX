(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXImageReferenceSelection = api;
})(typeof window === 'undefined' ? globalThis : window, function (root) {
  'use strict';
  const MAX_REFERENCES = 2;
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const manifestKey = references => JSON.stringify(canonical(references));
  const changed = () => new Error('The selected references changed while they were being prepared. Check them and send again; your draft is kept.');
  async function digest(base64) {
    const binary = root.atob(base64), bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (!root.crypto?.subtle) throw new Error('This browser cannot verify the selected reference bytes. Open the Workshop through its HTTPS entry.');
    const value = await root.crypto.subtle.digest('SHA-256', bytes);
    return { sha256: Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join(''), bytes: bytes.length };
  }
  async function prepareFile(file) {
    if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choose a PNG or JPEG image.');
    const url = root.URL.createObjectURL(file);
    try {
      const image = new root.Image(); image.src = url; await image.decode();
      const ratio = Math.min(1, 1536 / Math.max(image.width, image.height));
      const canvas = root.document.createElement('canvas');
      canvas.width = Math.round(image.width * ratio); canvas.height = Math.round(image.height * ratio);
      const context = canvas.getContext('2d');
      if (!context || !canvas.width || !canvas.height) throw new Error('The selected image cannot be prepared.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
      return { base64, mimeType: 'image/jpeg', width: canvas.width, height: canvas.height,
        transformation: 'browser-jpeg-working-copy', ...await digest(base64) };
    } finally { root.URL.revokeObjectURL(url); }
  }
  async function prepareSketch(sketch) {
    if (sketch.mimeType !== 'image/png') throw new Error('The composition sketch must be a PNG image.');
    const image = new root.Image(); image.src = `data:image/png;base64,${sketch.base64}`; await image.decode();
    return { base64: sketch.base64, mimeType: 'image/png', width: image.width, height: image.height,
      transformation: 'composition-sketch', ...await digest(sketch.base64) };
  }
  function create({ getSelection, file = prepareFile, sketch = prepareSketch, upload, resolve, onChange = () => {} }) {
    const files = new WeakMap(), sketches = new WeakMap(), identities = new WeakMap(), uploads = new Map();
    let nextIdentity = 0, accepted = null;
    const identity = value => {
      if (!identities.has(value)) identities.set(value, ++nextIdentity);
      return identities.get(value);
    };
    function snapshot() {
      const value = getSelection(), selectedFiles = Array.from(value.files || []), parent = value.parent || null, guide = value.sketch || null;
      const key = JSON.stringify([value.epoch, parent?.operationId, parent?.sha256, selectedFiles.map(identity), guide ? identity(guide) : null]);
      return { key, parent, files: selectedFiles, sketch: guide, count: selectedFiles.length + Number(!!parent) + Number(!!guide) };
    }
    const assertCurrent = selection => { if (snapshot().key !== selection.key) throw changed(); };
    function cached(cache, value, prepare) {
      if (!cache.has(value)) {
        const pending = Promise.resolve().then(() => prepare(value)); cache.set(value, pending);
        pending.catch(() => { if (cache.get(value) === pending) cache.delete(value); });
      }
      return cache.get(value);
    }
    async function prepare(selection) {
      if (selection.count > MAX_REFERENCES) throw new Error('Two references at most, including the chosen creation and the sketch.');
      const values = await Promise.all(selection.files.map(value => cached(files, value, file)));
      if (selection.sketch) values.push(await cached(sketches, selection.sketch, sketch));
      assertCurrent(selection);
      return values;
    }
    async function render() {
      const selection = snapshot(), prepared = await prepare(selection);
      return { parent: selection.parent, references: prepared.map(value => value.base64),
        ...(accepted?.key === selection.key && { referenceSelection: clone(accepted.references) }) };
    }
    async function inspect(sessionId) {
      const selection = snapshot();
      if (!selection.count) throw new Error('Attach one or two references before requesting inspection.');
      if (accepted?.key === selection.key && accepted.sessionId === sessionId) return clone(accepted.references);
      const prepared = await prepare(selection);
      if (prepared.reduce((total, value) => total + value.bytes, 0) > 3 * 1024 * 1024) throw new Error('The selected references exceed the 3 MiB inspection limit. Keep your draft and choose smaller inputs.');
      const selectors = selection.parent ? [{ kind: 'parent', operationId: selection.parent.operationId, sha256: selection.parent.sha256 }] : [];
      for (let index = 0; index < prepared.length; index++) {
        assertCurrent(selection);
        const value = prepared[index], kind = index < selection.files.length ? 'upload' : 'sketch';
        const key = JSON.stringify([sessionId, kind, value.sha256, selection.files[index] ? identity(selection.files[index]) : null]);
        if (!uploads.has(key)) {
          const pending = Promise.resolve().then(() => upload(sessionId, value, kind, selection.files[index])); uploads.set(key, pending);
          pending.catch(() => { if (uploads.get(key) === pending) uploads.delete(key); });
        }
        selectors.push(await uploads.get(key)); assertCurrent(selection);
      }
      const references = await resolve(sessionId, selectors); assertCurrent(selection);
      if (!Array.isArray(references) || references.length !== selection.count || references.some((value, index) =>
        value.kind !== selectors[index].kind || value.sha256 !== selectors[index].sha256 ||
        (value.kind === 'parent' ? value.operationId !== selectors[index].operationId : value.attachmentId !== selectors[index].attachmentId))) {
        throw new Error('The selected reference receipt is incomplete or changed. Nothing was sent for inspection.');
      }
      accepted = { key: selection.key, sessionId, references: clone(references) }; onChange();
      return clone(references);
    }
    function current() { return accepted?.key === snapshot().key ? clone(accepted.references) : null; }
    return { render, inspect, current, key: () => snapshot().key,
      matches: references => Array.isArray(references) && current() !== null && manifestKey(references) === manifestKey(current()),
      invalidate() { accepted = null; onChange(); } };
  }
  return { MAX_REFERENCES, create, prepareFile, prepareSketch, digest };
});
