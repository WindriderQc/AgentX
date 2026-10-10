'use strict';
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const ImageOperation = require('../../../models/ImageOperation');
const { defaultArchive } = require('../imageArchive');
const { decode } = require('./codec');

const SCHEMA = 'agentx.protected-image-composition/v1';
const MAX_PIXELS = 4300800, MAX_REGIONS = 20;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function closed(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function request(value) {
  if (!closed(value, ['parentSha256', 'resultSha256', 'regions']) || typeof value.parentSha256 !== 'string' || !SHA.test(value.parentSha256)
    || typeof value.resultSha256 !== 'string' || !SHA.test(value.resultSha256) || !Array.isArray(value.regions)
    || !value.regions.length || value.regions.length > MAX_REGIONS) throw fail('Choisis de 1 à 20 zones et des images archivées valides.');
  const regions = value.regions.map(region => {
    if (!closed(region, ['x', 'y', 'width', 'height']) || !Object.values(region).every(Number.isSafeInteger)
      || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) throw fail('Les zones doivent utiliser des coordonnées entières positives.');
    return { x: region.x, y: region.y, width: region.width, height: region.height };
  });
  return { parentSha256: value.parentSha256, resultSha256: value.resultSha256, regions };
}

function compose(parentBytes, resultBytes, regions) {
  for (const bytes of [parentBytes, resultBytes]) {
    if (Buffer.isBuffer(bytes) && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes[28] === 1) throw fail('Les PNG entrelacés ne sont pas pris en charge par la composition protégée.', 409);
  }
  let parent, result;
  try { parent = decode(parentBytes, MAX_PIXELS); result = decode(resultBytes, MAX_PIXELS); }
  catch { throw fail('Une image archivée ne peut pas être décodée dans les limites de composition.', 409); }
  if (parent.width !== result.width || parent.height !== result.height) {
    throw fail('Le parent et le résultat doivent avoir exactement les mêmes dimensions. Aucun redimensionnement automatique.', 409);
  }
  const width = parent.width, height = parent.height;
  const checked = request({ parentSha256: hash(parentBytes), resultSha256: hash(resultBytes), regions }).regions;
  if (checked.some(r => r.x + r.width > width || r.y + r.height > height)) throw fail('Une zone dépasse les dimensions du parent.');
  const mask = Buffer.alloc(width * height);
  const output = Buffer.from(parent.data);
  for (const region of checked) {
    for (let y = region.y; y < region.y + region.height; y += 1) {
      const start = y * width + region.x, end = start + region.width;
      mask.fill(1, start, end);
      result.data.copy(output, start * 4, start * 4, end * 4);
    }
  }
  const png = PNG.sync.write({ width, height, data: output }, { colorType: 6 });
  // Receive the guarantee from the exported PNG, not only the working buffer.
  const exported = decode(png, MAX_PIXELS);
  const outside = crypto.createHash('sha256');
  let protectedPixels = 0;
  for (let start = 0; start < mask.length;) {
    if (mask[start]) { start += 1; continue; }
    let end = start + 1;
    while (end < mask.length && !mask[end]) end += 1;
    const source = parent.data.subarray(start * 4, end * 4);
    if (!source.equals(exported.data.subarray(start * 4, end * 4))) throw fail('La vérification des pixels protégés a échoué.', 503);
    outside.update(source); protectedPixels += end - start; start = end;
  }
  return { png, width, height, regions: checked, proof: {
    contract: 'decoded-rgba-row-major-outside-rectangle-union/v1',
    decoder: 'pngjs-7.0.0/jpeg-js-0.4.4', verified: true,
    protectedPixels, selectedPixels: width * height - protectedPixels,
    outsideRgbaSha256: outside.digest('hex'), outputSha256: hash(png)
  } };
}

function createService({ operations = ImageOperation, archive = defaultArchive } = {}) {
  let busy = false;
  const read = id => operations.findById(id).lean();
  const identity = op => JSON.stringify([op?._id, op?.state, op?.runtimeRestored, op?.artifact, op?.lineage]);
  const ready = op => op?.state === 'completed' && op.runtimeRestored === true && op.artifact && SHA.test(op.artifact.sha256 || '');
  async function build(id, body) {
    if (!UUID.test(id || '')) throw fail('Opération image inconnue.', 404);
    const input = request(body);
    if (busy) throw fail('Une composition est déjà en préparation. Réessaie après sa fin.', 409);
    busy = true;
    try {
      const child = await read(id), link = child?.lineage?.parent;
      if (!ready(child) || !link || !UUID.test(link.operationId || '') || link.operationId === id) {
        throw fail('Choisis une retouche terminée avec un parent archivé et les ressources restituées.', 409);
      }
      const parent = await read(link.operationId);
      if (!ready(parent) || parent.artifact.sha256 !== link.sha256 || input.parentSha256 !== link.sha256
        || child.artifact.sha256 !== input.resultSha256 || parent.artifact.width !== link.width || parent.artifact.height !== link.height) {
        throw fail('Les empreintes ou le parent enregistré ne correspondent plus à cette sélection.', 409);
      }
      const parentIdentity = identity(parent), childIdentity = identity(child);
      // Canonical archive receipts only; callers cannot supply bytes, paths or URLs.
      const storage = archive();
      const p = await storage.read(parent.artifact), r = await storage.read(child.artifact);
      if (hash(p.bytes) !== input.parentSha256 || hash(r.bytes) !== input.resultSha256) throw fail('Les images archivées ont une empreinte incohérente.', 503);
      const output = compose(p.bytes, r.bytes, input.regions);
      if (output.width !== link.width || output.height !== link.height
        || output.width !== child.artifact.width || output.height !== child.artifact.height) throw fail('Les dimensions archivées sont incohérentes.', 503);
      if (identity(await read(parent._id)) !== parentIdentity || identity(await read(child._id)) !== childIdentity) {
        throw fail('La sélection archivée a changé pendant la préparation. Recharge les images.', 409);
      }
      return { receipt: { schema: SCHEMA, parent: { operationId: parent._id, sha256: input.parentSha256 },
        result: { operationId: child._id, sha256: input.resultSha256 }, width: output.width, height: output.height,
        regions: output.regions, proof: output.proof }, png: output.png.toString('base64') };
    } finally { busy = false; }
  }
  return { build };
}

module.exports = { ...createService(), createService, compose, request, SCHEMA, MAX_REGIONS, MAX_PIXELS };
