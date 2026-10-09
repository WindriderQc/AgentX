'use strict';
const ImageOperation = require('../../../models/ImageOperation');
const { defaultArchive, MAX_BYTES } = require('../imageArchive');
const { decode } = require('./codec');
const { declaredRecipe } = require('./recipeExecution');
const { validateGraph, object, uuid, digest, sha } = require('./exportGraphV1');
const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const invalid = () => fail('Les données archivées sont incohérentes ou indisponibles.', 503);
const requireValid = value => { if (!value) throw invalid(); };
const SELECT = '+execution +referenceStorage +request';
const PART_NAME = /^(graph\.json|output\.(png|jpg)|reference-[01]-(source\.(png|jpg)|worker\.png))$/;
const read = id => ImageOperation.findById(id).select(SELECT).lean();
const identity = op => JSON.stringify([op._id, op.state, op.runtimeRestored, op.profile, op.request, op.execution,
  op.lineage, op.referenceStorage, op.artifact, op.updatedAt]);

function references(op) {
  if (Object.hasOwn(op, 'referenceStorage') && op.referenceStorage !== undefined) requireValid(object(op.referenceStorage));
  if (!op.referenceStorage) {
    if (op.lineage?.references?.length) {
      throw fail('Les références historiques complètes ne sont pas enregistrées pour cet export.', 409);
    }
    requireValid(!op.lineage); return { entries: [], lineage: undefined };
  }
  const s = op.referenceStorage, l = op.lineage;
  requireValid(s.version === 1 && Array.isArray(s.entries) && s.entries.length >= 1 && s.entries.length <= 2
    && l?.version === 1 && Array.isArray(l.references) && l.references.length === s.entries.length);
  const lineage = { version: 1, references: [] };
  for (let i = 0; i < s.entries.length; i++) {
    const entry = s.entries[i], link = l.references[i];
    requireValid(object(entry) && object(link) && digest(link.sourceSha256) && digest(link.workerSha256)
      && link.transform === 'decoded-pixels-to-png-v1' && entry.source?.sha256 === link.sourceSha256 && entry.worker?.sha256 === link.workerSha256);
    if (link.parentOperationId !== undefined) requireValid(i === 0 && l.parent && link.parentOperationId === l.parent.operationId);
    lineage.references.push({ sourceSha256: link.sourceSha256, workerSha256: link.workerSha256, transform: link.transform,
      ...(link.parentOperationId !== undefined && { parentOperationId: link.parentOperationId }) });
  }
  if (l.parent) {
    const p = l.parent;
    requireValid(uuid(p.operationId) && digest(p.sha256) && l.references[0].parentOperationId === p.operationId
      && l.references[0].sourceSha256 === p.sha256 && p.width === s.entries[0].source.width && p.height === s.entries[0].source.height);
    lineage.parent = { operationId: p.operationId, sha256: p.sha256, width: p.width, height: p.height };
  }
  return { entries: s.entries, lineage };
}

function descriptor(id, receipt, role, index) {
  requireValid(object(receipt) && digest(receipt.sha256) && ['image/png', 'image/jpeg'].includes(receipt.mimeType)
    && Number.isSafeInteger(receipt.size) && receipt.size > 0 && receipt.size <= MAX_BYTES
    && ['uploaded', 'generated'].includes(receipt.origin) && typeof receipt.archivedAt === 'string' && Number.isFinite(Date.parse(receipt.archivedAt))
    && [receipt.width, receipt.height].every(n => Number.isInteger(n) && n > 0));
  const extension = receipt.mimeType === 'image/png' ? 'png' : 'jpg';
  requireValid(role !== 'worker' || extension === 'png');
  const name = role === 'output' ? `output.${extension}` : `reference-${index}-${role}.${extension}`;
  return { name, role, ...(index !== undefined && { index }), sha256: receipt.sha256, mimeType: receipt.mimeType,
    size: receipt.size, width: receipt.width, height: receipt.height,
    url: `/api/images/operations/${id}/export/parts/${name}` };
}

async function verify(receipt, part) {
  try {
    const loaded = await defaultArchive().read(receipt);
    requireValid(Buffer.isBuffer(loaded.bytes) && loaded.bytes.length === part.size
      && sha(loaded.bytes) === part.sha256 && loaded.mimeType === part.mimeType);
    const image = decode(loaded.bytes, part.role === 'output' ? 4300800 : 4194304);
    requireValid(image.width === part.width && image.height === part.height && image.mimeType === part.mimeType);
    if (part.role !== 'output') requireValid(Math.max(image.width, image.height) / Math.min(image.width, image.height) <= 8);
    return loaded.bytes;
  } catch { throw invalid(); }
}

async function bundle(id, requestedName) {
  if (!uuid(id) || requestedName !== undefined && (typeof requestedName !== 'string' || !PART_NAME.test(requestedName))) {
    throw fail('Pièce ou opération image inconnue.', 404);
  }
  const op = await read(id);
  if (!op) throw fail('Opération image inconnue.', 404);
  if (op.state !== 'completed' || op.runtimeRestored !== true) throw fail('L’export exige une image terminée et ses ressources restituées.', 409);
  if (!op.execution || !op.artifact) throw fail('Cette opération historique ne possède pas un export complet enregistré.', 409);
  requireValid(op._id === id && typeof op.profile?.id === 'string' && /^[a-z0-9-]{1,50}$/.test(op.profile.id));
  const { entries, lineage } = references(op);
  const graph = validateGraph(op, entries.length);
  let declaration;
  if (op.profile.recipe !== undefined) {
    try { declaration = declaredRecipe(op.profile.recipe); } catch { throw invalid(); }
  }
  const graphPart = { name: 'graph.json', role: 'graph', sha256: sha(graph), mimeType: 'application/json', size: graph.length,
    url: `/api/images/operations/${id}/export/parts/graph.json` };
  const pieces = [];
  for (let i = 0; i < entries.length; i++) {
    const { source, worker } = entries[i];
    requireValid(source?.width === worker?.width && source?.height === worker?.height);
    pieces.push({ receipt: source, part: descriptor(id, source, 'source', i) }, { receipt: worker, part: descriptor(id, worker, 'worker', i) });
  }
  pieces.push({ receipt: op.artifact, part: descriptor(id, op.artifact, 'output') });
  const parts = [graphPart, ...pieces.map(item => item.part)];
  if (requestedName !== undefined && !parts.some(p => p.name === requestedName)) throw fail('Pièce image inconnue.', 404);
  // Validate every advertised piece before publishing a manifest. Repeated part
  // requests independently re-read all receipts; no durable validation cache.
  let bytes = requestedName === 'graph.json' ? graph : undefined;
  for (const item of pieces) {
    const verified = await verify(item.receipt, item.part);
    if (item.part.name === requestedName) bytes = verified;
  }
  const latest = await read(id);
  if (!latest || identity(latest) !== identity(op)) throw fail('L’opération a changé pendant son export. Recharge son état.', 409);
  if (requestedName !== undefined) return { bytes, mimeType: parts.find(p => p.name === requestedName).mimeType, filename: requestedName };
  return { schemaVersion: 1, operation: { id, state: 'completed', runtimeRestored: true },
    recipe: { id: op.profile.id, family: op.profile.family, ...(declaration && { declaredIdentity: declaration }) },
    request: { prompt: op.request.prompt, width: op.request.width, height: op.request.height, seed: op.request.seed },
    execution: { builder: { id: op.execution.builder.id, version: op.execution.builder.version },
      graphSha256: op.execution.graphSha256, parameters: { ...op.execution.parameters } },
    ...(lineage && { lineage }), parts };
}
module.exports = { manifest: id => bundle(id), part: (id, name) => bundle(id, name) };
