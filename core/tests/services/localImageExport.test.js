'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const ImageOperation = require('../../models/ImageOperation');
const { defaultArchive } = require('../../src/services/imageArchive');
const { reference } = require('../../src/services/images/codec');
const { buildExecution } = require('../../src/services/images/recipeExecution');

jest.mock('../../src/services/images/config', () => ({ loadConfig: jest.fn(() => { throw new Error('Synthetic current configuration is offline'); }) }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn(() => { throw new Error('No export worker call'); }) }));
jest.mock('../../src/services/images/gpuReservation', () => ({ reserve: jest.fn(() => { throw new Error('No export reservation'); }) }));
jest.mock('../../src/services/images/imageService', () => ({
  initialize: jest.fn(), get: jest.fn(), list: jest.fn(), recover: jest.fn(), accept: jest.fn(), retryArchive: jest.fn()
}));
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { reserve } = require('../../src/services/images/gpuReservation');
const imageService = require('../../src/services/images/imageService');
let exportModule;
try { exportModule = require('../../src/services/images/recipeExport'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes("'../../src/services/images/recipeExport'")) throw error;
}
const api = () => { expect(exportModule).toBeDefined(); return exportModule; };
const manifest = id => api().manifest(id);
const part = (id, name) => api().part(id, name);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const png = (color = 255) => PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, color) });
const jpg = jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }, 30).data;
const DIMENSIONS = { width: 2, height: 2 };
let directory, writes, outsideFiles;

async function fixture({ family = 'klein', references = [], parent = false, output = png(), declaration = true,
  state = 'completed', runtimeRestored = true } = {}) {
  const id = crypto.randomUUID(), archive = defaultArchive();
  const profile = { id: 'historical-quality', family, diffusion: 'historical-diffusion.safetensors', encoder: 'historical-encoder.safetensors',
    vae: 'historical-vae.safetensors', steps: family === 'klein' ? 4 : 20, maxPixels: 4194304,
    privateSecret: 'FAKE_PRIVATE_PROFILE_SECRET', presentation: { description: 'FAKE_PRIVATE_PROFILE_DESCRIPTION' },
    ...(declaration && { recipe: { id: 'historical.recipe', version: 'v1' } }) };
  const request = { prompt: 'SYNTHETIC_EXPORT_BRIEF_MARKER', width: 1024, height: 1024, seed: 42 };
  const artifact = { ...await archive.store({ bytes: output, origin: 'generated' }), ...DIMENSIONS };
  const entries = [], descriptors = [], workers = references.map(reference);
  const parentId = parent ? crypto.randomUUID() : undefined;
  for (let i = 0; i < references.length; i++) {
    const source = { ...await archive.store({ bytes: references[i], origin: parent && i === 0 ? 'generated' : 'uploaded' }), ...DIMENSIONS };
    const worker = { ...await archive.store({ bytes: workers[i], origin: 'uploaded' }), ...DIMENSIONS };
    entries.push({ source, worker });
    descriptors.push({ sourceSha256: sha(references[i]), workerSha256: sha(workers[i]), transform: 'decoded-pixels-to-png-v1',
      ...(parent && i === 0 && { parentOperationId: parentId }) });
  }
  const lineage = references.length ? { version: 1, references: descriptors,
    ...(parent && { parent: { operationId: parentId, sha256: sha(references[0]), ...DIMENSIONS } }) } : undefined;
  const names = references.map((_bytes, index) => `agentx-${id}-${index}.png`);
  const execution = buildExecution(profile, request, names, id);
  await ImageOperation.create({ _id: id, actionKey: `export-${id}`, requestHash: sha(id), state, runtimeRestored, profile,
    request: { ...request, privateSecret: 'FAKE_PRIVATE_REQUEST_SECRET' }, artifact, execution,
    ...(lineage && { lineage, referenceStorage: { version: 1, entries } }),
    workerUrl: 'http://127.0.0.1:8188/FAKE_PRIVATE_WORKER', snapshot: { secret: 'FAKE_PRIVATE_SNAPSHOT' },
    admission: { secret: 'FAKE_PRIVATE_ADMISSION' }, conversation: { surface: 'household', sessionId: 'FAKE_PRIVATE_SESSION', packId: 'fixture', scopeId: 'private' } });
  if (parent) await ImageOperation.create({ _id: parentId, actionKey: `parent-${parentId}`, requestHash: sha(parentId),
    state: 'completed', runtimeRestored: true, profile, request, artifact: entries[0].source });
  return { id, profile, request, execution, references, workers, artifact, entries, lineage, output, parentId };
}

async function alter(id, fields, unset = {}) {
  await ImageOperation.collection.updateOne({ _id: id }, { $set: fields, ...(Object.keys(unset).length && { $unset: unset }) });
}
async function corruptGraph(f, mutate, recompute = true) {
  const graph = clone(f.execution.graph); mutate(graph);
  await alter(f.id, { 'execution.graph': graph, ...(recompute && { 'execution.graphSha256': sha(JSON.stringify(graph)) }) });
}
function forbidWrites() {
  writes = [];
  for (const method of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'chmod', 'chown']) {
    const spy = jest.spyOn(fs.promises, method).mockImplementation(() => { throw new Error('Export attempted a filesystem write'); });
    writes.push(spy);
  }
  for (const method of ['create', 'updateOne', 'updateMany', 'findByIdAndUpdate', 'findOneAndUpdate', 'deleteOne', 'deleteMany']) {
    const spy = jest.spyOn(ImageOperation, method).mockImplementation(() => { throw new Error('Export attempted a Mongo write'); });
    writes.push(spy);
  }
}
async function fingerprint() {
  const files = [];
  const walk = root => {
    for (const name of fs.readdirSync(root).sort()) {
      const p = path.join(root, name), s = fs.lstatSync(p);
      if (s.isDirectory()) walk(p);
      else files.push({ path: path.relative(directory, p), sha256: sha(fs.readFileSync(p)), mode: s.mode & 0o777 });
    }
  };
  walk(directory);
  return { files, mongo: JSON.stringify(await ImageOperation.collection.find({}).sort({ _id: 1 }).toArray()) };
}
function noRuntimeCalls() {
  expect(loadConfig).not.toHaveBeenCalled(); expect(createComfyClient).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  for (const method of Object.values(imageService)) expect(method).not.toHaveBeenCalled();
  for (const spy of writes || []) expect(spy).not.toHaveBeenCalled();
}
function publicMetadata(f, exported) {
  const top = ['schemaVersion', 'operation', 'recipe', 'request', 'execution', 'parts', ...(f.lineage ? ['lineage'] : [])].sort();
  expect(Object.keys(exported).sort()).toEqual(top);
  expect(exported.schemaVersion).toBe(1);
  expect(exported.operation).toEqual({ id: f.id, state: 'completed', runtimeRestored: true });
  expect(exported.recipe).toEqual({ id: f.profile.id, family: f.profile.family,
    ...(f.profile.recipe && { declaredIdentity: f.profile.recipe }) });
  expect(exported.request).toEqual(f.request);
  expect(exported.execution).toEqual({ builder: f.execution.builder, graphSha256: f.execution.graphSha256, parameters: f.execution.parameters });
  if (f.lineage) expect(exported.lineage).toEqual(f.lineage);
  const serialized = JSON.stringify(exported);
  expect(serialized).toContain('SYNTHETIC_EXPORT_BRIEF_MARKER');
  expect(serialized).not.toMatch(/FAKE_PRIVATE_|\/home\/|\/srv\/|workerUrl|referenceStorage|snapshot|admission|conversation/);
  const names = ['graph.json', f.artifact.mimeType === 'image/jpeg' ? 'output.jpg' : 'output.png'];
  f.entries.forEach((entry, index) => names.push(`reference-${index}-source.${entry.source.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`, `reference-${index}-worker.png`));
  expect(exported.parts.map(p => p.name).sort()).toEqual(names.sort());
  for (const p of exported.parts) {
    expect(Object.keys(p).every(k => ['name', 'role', 'index', 'sha256', 'mimeType', 'size', 'width', 'height', 'url'].includes(k))).toBe(true);
    expect(p.url).toBe(`/api/images/operations/${f.id}/export/parts/${p.name}`);
  }
  expect(exported.parts.filter(p => p.role === 'source').map(p => p.index)).toEqual(f.entries.map((_e, i) => i));
  expect(exported.parts.filter(p => p.role === 'worker').map(p => p.index)).toEqual(f.entries.map((_e, i) => i));
}
async function exactParts(f, exported) {
  const graphBytes = Buffer.from(JSON.stringify(f.execution.graph));
  for (const descriptor of exported.parts) {
    let expected;
    if (descriptor.role === 'graph') { expected = graphBytes; expect(descriptor.name).toBe('graph.json'); expect(descriptor.mimeType).toBe('application/json'); }
    else if (descriptor.role === 'output') expected = f.output;
    else if (descriptor.role === 'source') expected = f.references[descriptor.index];
    else if (descriptor.role === 'worker') expected = f.workers[descriptor.index];
    else throw new Error('Unexpected exported role');
    expect(descriptor.sha256).toBe(sha(expected)); expect(descriptor.size).toBe(expected.length);
    if (descriptor.role !== 'graph') expect({ width: descriptor.width, height: descriptor.height }).toEqual(DIMENSIONS);
    const downloaded = await part(f.id, descriptor.name);
    expect(downloaded.filename).toBe(descriptor.name); expect(downloaded.mimeType).toBe(descriptor.mimeType);
    expect(Buffer.isBuffer(downloaded.bytes)).toBe(true); expect(downloaded.bytes.equals(expected)).toBe(true);
    expect(Object.keys(downloaded).sort()).toEqual(['bytes', 'filename', 'mimeType']);
  }
}
beforeEach(async () => {
  jest.restoreAllMocks(); jest.clearAllMocks(); writes = []; outsideFiles = [];
  await ImageOperation.createCollection(); await ImageOperation.deleteMany({});
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-image-export-fixture-'));
  process.env.IMAGE_ARCHIVE_DIR = directory;
});
afterEach(() => {
  try { noRuntimeCalls(); }
  finally {
    jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
    for (const file of outsideFiles) fs.rmSync(file, { force: true });
    delete process.env.IMAGE_ARCHIVE_DIR;
  }
});

test('completed historical Klein without references exports exact graph/output and a closed public manifest while current config is offline', async () => {
  const f = await fixture(); const before = await fingerprint(); forbidWrites();
  const exported = await manifest(f.id); publicMetadata(f, exported); await exactParts(f, exported);
  expect(await fingerprint()).toEqual(before);
});
test('a Qwen child exports two ordered parent/manual references from durable receipts without needing the parent Mongo operation', async () => {
  const f = await fixture({ family: 'qwen21', references: [jpg, png(64)], parent: true });
  await ImageOperation.deleteOne({ _id: f.parentId }); const before = await fingerprint(); forbidWrites();
  const exported = await manifest(f.id); publicMetadata(f, exported); await exactParts(f, exported);
  expect(exported.parts.find(p => p.name === 'reference-0-source.jpg').sha256).toBe(sha(jpg));
  expect(exported.parts.find(p => p.name === 'reference-1-source.png').sha256).toBe(sha(png(64)));
  expect(await fingerprint()).toEqual(before);
});
test('an undeclared historical recipe remains undeclared and exports a JPEG output under its strict public name', async () => {
  const f = await fixture({ family: 'qwen21', declaration: false, output: jpg }); forbidWrites();
  const exported = await manifest(f.id); publicMetadata(f, exported); await exactParts(f, exported);
  expect(exported.recipe.declaredIdentity).toBeUndefined(); expect(exported.parts.some(p => p.name === 'output.jpg')).toBe(true);
});
test('a legitimate recorded 255-character weight filename is preserved without imposing a new profile limit', async () => {
  const f = await fixture(), weight = 'a'.repeat(243) + '.safetensors';
  expect(weight.length).toBe(255);
  f.profile.diffusion = weight; f.execution.graph.model.inputs.unet_name = weight;
  f.execution.graphSha256 = sha(JSON.stringify(f.execution.graph));
  await alter(f.id, { 'profile.diffusion': weight, execution: f.execution }); forbidWrites();
  const exported = await manifest(f.id); publicMetadata(f, exported); await exactParts(f, exported);
});
test('repeated manifest/part downloads preserve the exact archive and Mongo bytes and never initialize or dispatch runtime work', async () => {
  const f = await fixture({ references: [jpg] }), before = await fingerprint(); forbidWrites();
  const first = await manifest(f.id); await exactParts(f, first);
  expect(await manifest(f.id)).toEqual(first); await exactParts(f, first); expect(await fingerprint()).toEqual(before);
});

test.each(['accepted', 'reserving', 'generating', 'archiving', 'restoring', 'unknown', 'failed', 'cancelled', 'archive_failed'])
  ('state %s is nonexportable before any archive access or write', async state => {
    const f = await fixture({ state }); forbidWrites();
    const open = jest.spyOn(fs.promises, 'open'), readFile = jest.spyOn(fs.promises, 'readFile'), lstat = jest.spyOn(fs.promises, 'lstat');
    await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(part(f.id, 'graph.json')).rejects.toMatchObject({ statusCode: 409 });
    expect(open).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled(); expect(lstat).not.toHaveBeenCalled();
  });
test('completed without proven runtime restoration refuses before any archive access', async () => {
  const f = await fixture({ runtimeRestored: false }); forbidWrites(); const open = jest.spyOn(fs.promises, 'open');
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 409 }); expect(open).not.toHaveBeenCalled();
});
test('a missing operation is 404 and never fabricates an export from current configuration', async () => {
  forbidWrites(); await expect(manifest(crypto.randomUUID())).rejects.toMatchObject({ statusCode: 404 });
});
test.each(['../graph.json', '/graph.json', 'reference-2-worker.png', 'output.jpeg', 'graph.json?x=1', '%2e%2e%2fgraph.json', null])
  ('part name %j cannot address arbitrary files or a nonexistent package member', async name => {
    const f = await fixture(); forbidWrites(); await expect(part(f.id, name)).rejects.toMatchObject({ statusCode: 404 });
  });
test('a legacy operation without an execution snapshot refuses 409 and retains its old data untouched', async () => {
  const f = await fixture(); await alter(f.id, {}, { execution: 1 }); const before = await fingerprint(); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 409 }); expect(await fingerprint()).toEqual(before);
});
test('lineage with no durable storage refuses legacy buffers instead of constructing reference exports', async () => {
  const f = await fixture({ references: [png()] }); await alter(f.id, { references: [f.workers[0]] }, { referenceStorage: 1 }); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 409 });
});
test('declared corrupt storage refuses 503 even when legacy buffers remain available', async () => {
  const f = await fixture({ references: [png()] }); await alter(f.id, { referenceStorage: null, references: [f.workers[0]] }); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});
test('an execution graph whose stored SHA no longer matches fails 503', async () => {
  const f = await fixture(); await corruptGraph(f, graph => { graph.noise.inputs.noise_seed++; }, false); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});

const graphMutations = [
  ['unknown executable node', graph => { graph.foreign = { class_type: 'HTTPProviderFixture', inputs: { url: 'http://127.0.0.1:9/FAKE' } }; }],
  ['unexpected node input', graph => { graph.model.inputs.private_url = 'http://127.0.0.1:9/FAKE'; }],
  ['mismatched historical prompt', graph => { graph.text.inputs.text = 'Different brief'; }],
  ['mismatched historical seed', graph => { graph.noise.inputs.noise_seed++; }],
  ['mismatched requested dimensions', graph => { graph.latent.inputs.width = 512; }],
  ['mismatched historical steps', graph => { graph.sigmas.inputs.steps++; }],
  ['mismatched historical weight name', graph => { graph.model.inputs.unet_name = 'different.safetensors'; }],
  ['absolute weight path', graph => { graph.clip.inputs.clip_name = '/private/FAKE/encoder.safetensors'; }],
  ['weight provider URL', graph => { graph.vae.inputs.vae_name = 'http://127.0.0.1:9/FAKE'; }],
  ['dangling graph edge', graph => { graph.decode.inputs.samples = ['missing-node', 0]; }],
  ['edge to the wrong class output', graph => { graph.decode.inputs.samples = ['clip', 0]; }],
  ['incorrect output slot', graph => { graph.decode.inputs.samples = ['sample', 99]; }],
  ['unbound output prefix', graph => { graph.save.inputs.filename_prefix = 'foreign/output'; }],
  ['unrecorded reference', graph => { graph.ref0 = { class_type: 'LoadImage', inputs: { image: 'foreign.png' } }; }]
];
test.each(graphMutations)('recomputed SHA cannot admit %s into the historical closed graph', async (_name, mutate) => {
  const f = await fixture(); await corruptGraph(f, mutate); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});
test('Qwen dotted reference inputs bind its recorded names and reject recomputed URL references', async () => {
  const f = await fixture({ family: 'qwen21', references: [jpg, png(64)] });
  await corruptGraph(f, graph => { graph.ref1.inputs.image = 'http://127.0.0.1:9/FAKE.png'; }); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});
test('execution parameters cannot diverge from the recorded request even with a valid graph SHA', async () => {
  const f = await fixture(); await alter(f.id, { 'execution.parameters.seed': 99 }); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});

test.each(['source', 'worker', 'output'])('manifest validates the missing %s piece instead of listing a fabricated download', async role => {
  const f = await fixture({ references: [jpg] }); const receipt = role === 'output' ? f.artifact : f.entries[0][role];
  fs.unlinkSync(path.join(directory, receipt.path)); forbidWrites(); await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});
test.each(['source', 'worker', 'output'])('manifest rejects a same-size corrupted %s piece without repairing it', async role => {
  const f = await fixture({ references: [jpg] }); const receipt = role === 'output' ? f.artifact : f.entries[0][role];
  const file = path.join(directory, receipt.path), bytes = Buffer.from(fs.readFileSync(file)); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  const before = await fingerprint(); forbidWrites(); await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 }); expect(await fingerprint()).toEqual(before);
});
test('storage entries cannot be swapped independently of ordered historical lineage', async () => {
  const f = await fixture({ references: [jpg, png(64)] }); await alter(f.id, { 'referenceStorage.entries': [f.entries[1], f.entries[0]] }); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});
test('reference dimensions must equal the actual archived bytes rather than trusting an altered receipt', async () => {
  const f = await fixture({ references: [jpg] }); await alter(f.id, { 'referenceStorage.entries.0.worker.width': 3 }); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});
test('output dimensions must match its verified decoded artifact', async () => {
  const f = await fixture(); await alter(f.id, { 'artifact.width': 3 }); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
});
test('a source receipt cannot escape the archive even if a matching file exists elsewhere', async () => {
  const f = await fixture({ references: [jpg] });
  const outside = path.join(path.dirname(directory), `durable-export-outside-${crypto.randomUUID()}.jpg`);
  fs.writeFileSync(outside, jpg); outsideFiles.push(outside);
  await alter(f.id, { 'referenceStorage.entries.0.source.path': `../${path.basename(outside)}` }); forbidWrites();
  await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 503 });
  expect(fs.readFileSync(outside).equals(jpg)).toBe(true);
});
test('each independent part request rechecks the whole package after a manifest was already downloaded', async () => {
  const f = await fixture({ references: [jpg] }); await manifest(f.id);
  fs.unlinkSync(path.join(directory, f.entries[0].source.path)); forbidWrites();
  await expect(part(f.id, 'graph.json')).rejects.toMatchObject({ statusCode: 503 });
});
test('an operation changed while its archive is being read refuses the stale export after a second real Mongo observation', async () => {
  const f = await fixture(), open = fs.promises.open.bind(fs.promises); let changed = false;
  jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!changed && String(args[0]).startsWith(directory + path.sep)) {
      changed = true; await ImageOperation.collection.updateOne({ _id: f.id }, { $set: { runtimeRestored: false } });
    }
    return handle;
  });
  forbidWrites(); await expect(manifest(f.id)).rejects.toMatchObject({ statusCode: 409 }); expect(changed).toBe(true);
});
