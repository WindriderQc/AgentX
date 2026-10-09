'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const ImageOperation = require('../../models/ImageOperation');
const { defaultArchive } = require('../../src/services/imageArchive');
jest.mock('../../src/services/images/config', () => ({ loadConfig: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/images/gpuReservation', () => ({ reserve: jest.fn() }));
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { reserve } = require('../../src/services/images/gpuReservation');
const service = require('../../src/services/images/imageService');
const presentation = require('../../src/services/images/workshopPresentation');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const png = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const identity = { id: 'fixture-edit', version: '1.0' };
const makeProfile = (family = 'klein', declared = true) => ({ family, diffusion: 'fixture.safetensors', encoder: 'encoder.safetensors',
  vae: 'vae.safetensors', steps: 7, maxPixels: 4194304, label: 'Fixture', ...(declared && { recipe: { ...identity } }) });
const body = extra => JSON.parse(JSON.stringify({ actionKey: `recipe-${crypto.randomUUID()}`, prompt: 'Synthetic scene', width: 512, height: 768,
  seed: 42, recipeId: identity.id, recipeVersion: identity.version, ...extra }));
const terminal = async id => {
  for (let i = 0; i < 100; i++) {
    const op = await service.get(id);
    if (['completed', 'failed', 'unknown', 'archive_failed', 'cancelled'].includes(op.state)) return op;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not settle');
};
let directory, client, submittedRecords;
function configure(profile = makeProfile()) {
  loadConfig.mockReturnValue({ workerUrl: 'http://127.0.0.1:8188', profiles: { quality: profile }, defaultProfile: 'quality' });
}
async function archivedParent() {
  const id = crypto.randomUUID();
  const artifact = await defaultArchive().store({ bytes: png, name: `${id}.png`, origin: 'generated', context: {} });
  return (await ImageOperation.create({ _id: id, actionKey: `parent-${id}`, requestHash: sha(id), state: 'completed',
    runtimeRestored: true, request: { prompt: 'Fixture', width: 512, height: 768, seed: 1 }, profile: { ...makeProfile(), id: 'quality' },
    artifact: { ...artifact, width: 2, height: 2 } })).toObject();
}
async function refusalBeforeEffects(input, statusCode) {
  const create = jest.spyOn(ImageOperation, 'create');
  const reads = jest.spyOn(fs.promises, 'readFile');
  let error, accepted;
  try { accepted = await service.accept(input); } catch (e) { error = e; }
  if (accepted) await terminal(accepted.id); // Let a broken baseline finish its mocked worker before teardown.
  expect(error).toMatchObject({ statusCode });
  expect(reads.mock.calls.filter(([p]) => String(p).startsWith(directory))).toHaveLength(0);
  expect(create).not.toHaveBeenCalled();
  expect(createComfyClient).not.toHaveBeenCalled(); expect(client.ready).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled(); expect(client.upload).not.toHaveBeenCalled(); expect(client.submit).not.toHaveBeenCalled();
}
beforeEach(async () => {
  jest.restoreAllMocks(); jest.clearAllMocks();
  await ImageOperation.createCollection(); await ImageOperation.deleteMany({});
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-recipe-fixture-'));
  process.env.IMAGE_ARCHIVE_DIR = directory; configure(); submittedRecords = [];
  client = { ready: jest.fn().mockResolvedValue({}), json: jest.fn().mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] }),
    upload: jest.fn(async (_bytes, name) => `uploaded-${name}`),
    submit: jest.fn(async (id, graph) => {
      const stored = await ImageOperation.findById(id).select('+execution').lean();
      submittedRecords.push({ stored, graph: JSON.parse(JSON.stringify(graph)) });
    }),
    observe: jest.fn(async (_id, options) => { await options.onTerminal(); return { filename: 'fixture.png', subfolder: '', type: 'output' }; }),
    read: jest.fn().mockResolvedValue(png), free: jest.fn().mockResolvedValue({}) };
  createComfyClient.mockReturnValue(client);
  reserve.mockResolvedValue({ assertOwned: jest.fn().mockResolvedValue(), verified: jest.fn().mockResolvedValue(),
    restore: jest.fn().mockResolvedValue(), quarantine: jest.fn().mockResolvedValue() });
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); delete process.env.IMAGE_ARCHIVE_DIR; });

test.each([
  { recipeVersion: undefined }, { recipeId: undefined }, { recipeId: null }, { recipeVersion: 1 },
  { recipeVersion: '' }, { recipeId: 'bad recipe' },
])('a malformed or partial expected recipe %j refuses before effects', async extra => {
  const p = await archivedParent();
  await refusalBeforeEffects(body({ ...extra, parent: { operationId: p._id, sha256: p.artifact.sha256 } }), 400);
});
test.each([{ recipeVersion: '2.0' }, { recipeId: 'different-recipe' }])('a mismatched expected recipe %j refuses before parent archive or worker', async extra => {
  const p = await archivedParent();
  await refusalBeforeEffects(body({ ...extra, parent: { operationId: p._id, sha256: p.artifact.sha256 } }), 409);
});
test('a legacy profile cannot satisfy an explicit recipe identity', async () => {
  configure(makeProfile('klein', false)); await refusalBeforeEffects(body(), 409);
});
test('a changed recipe pair on an existing action cannot return the previous receipt', async () => {
  const input = body(), child = await service.accept(input); await terminal(child.id);
  createComfyClient.mockClear(); client.ready.mockClear(); reserve.mockClear(); client.submit.mockClear();
  await refusalBeforeEffects({ ...input, recipeVersion: '2.0' }, 409);
});
test('an exact v1 replay returns its durable v1 operation after configuration changes to v2', async () => {
  const input = body(), child = await service.accept(input); await terminal(child.id);
  configure({ ...makeProfile(), steps: 9, recipe: { ...identity, version: '2.0' } });
  createComfyClient.mockClear(); client.ready.mockClear(); reserve.mockClear(); client.submit.mockClear();
  expect((await service.accept(input)).id).toBe(child.id);
  expect(createComfyClient).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(client.submit).not.toHaveBeenCalled();
  const details = await presentation.details(child.id);
  expect(details.recipe.declaredIdentity).toEqual(identity); expect(details.recipe.steps).toBe(7);
});
test('an unpaired legacy request keeps the original request hash identity', async () => {
  configure(makeProfile('klein', false)); const input = body({ recipeId: undefined, recipeVersion: undefined });
  const accepted = await service.accept(input); await terminal(accepted.id);
  const stored = await ImageOperation.findById(accepted.id).lean();
  expect(stored.requestHash).toBe(sha(JSON.stringify({ prompt: input.prompt, width: 512, height: 768, seed: 42, profile: 'quality', references: [] })));
});
test.each([['klein', false], ['qwen21', false], ['klein', true], ['qwen21', true]])(
  'every new %s operation (declared=%s) journals the submitted graph before submission and preserves it at terminal', async (family, declared) => {
    configure(makeProfile(family, declared));
    const input = body({ ...(declared ? {} : { recipeId: undefined, recipeVersion: undefined }),
      graph: { forged: { class_type: 'CallerInjected' } }, execution: { graphSha256: '0'.repeat(64) } });
    const accepted = await service.accept(input); const done = await terminal(accepted.id);
    expect(done.state).toBe('completed'); expect(submittedRecords).toHaveLength(1);
    const { stored, graph } = submittedRecords[0];
    expect(stored.execution).toMatchObject({ version: 1, builder: { id: 'agentx.local-images.workflows', version: 1 },
      graph, graphSha256: sha(JSON.stringify(graph)), parameters: { width: 512, height: 768, seed: 42, steps: 7 } });
    expect(stored.dispatchStarted).toBe(true); expect(graph.forged).toBeUndefined();
    const final = await ImageOperation.findById(accepted.id).select('+execution +references').lean();
    expect(final.execution).toEqual(stored.execution);
    expect(final.references == null || final.references.length === 0).toBe(true);
    expect(graph.model.inputs.unet_name).toBe('fixture.safetensors');
    if (family === 'klein') {
      expect(graph.sigmas.inputs).toMatchObject({ steps: 7, width: 512, height: 768 }); expect(graph.noise.inputs.noise_seed).toBe(42);
    } else {
      expect(graph.sample.inputs).toMatchObject({ steps: 7, seed: 42 }); expect(graph.text.inputs.resolution).toBe(640);
    }
    const details = await presentation.details(accepted.id);
    expect(details.execution).toMatchObject({ builder: stored.execution.builder, graphSha256: stored.execution.graphSha256, parameters: stored.execution.parameters });
    expect(details.execution.graph).toBeUndefined();
    expect((await service.get(accepted.id)).execution).toBeUndefined();
  });
test.each(['klein', 'qwen21'])('the %s archived graph preserves real upload names with parent first', async family => {
  configure(makeProfile(family)); const p = await archivedParent();
  const accepted = await service.accept(body({ parent: { operationId: p._id, sha256: p.artifact.sha256 }, references: [png.toString('base64')] }));
  await terminal(accepted.id); const { stored, graph } = submittedRecords[0];
  expect(stored.execution).toBeDefined();
  expect(stored.execution.graph).toEqual(graph);
  expect(graph.ref0.inputs.image).toBe(`uploaded-agentx-${accepted.id}-0.png`);
  expect(graph.ref1.inputs.image).toBe(`uploaded-agentx-${accepted.id}-1.png`);
  if (family === 'qwen21') expect(graph.text.inputs.resolution).toBe(608);
});
test('a rejected execution journal write cannot dispatch a worker submission', async () => {
  const collection = ImageOperation.collection;
  const originalWrite = collection.findOneAndUpdate.bind(collection); let rejected = false;
  jest.spyOn(collection, 'findOneAndUpdate').mockImplementation((filter, update, ...args) => {
    if (!rejected && update.$set?.execution) { rejected = true; return Promise.reject(new Error('Fixture journal unavailable')); }
    return originalWrite(filter, update, ...args);
  });
  const accepted = await service.accept(body()); await terminal(accepted.id);
  expect(rejected).toBe(true); expect(client.submit).not.toHaveBeenCalled();
});
test('an older operation receives neither invented recipe version nor execution descriptors', async () => {
  const p = await archivedParent(); await ImageOperation.updateOne({ _id: p._id }, { $unset: { 'profile.recipe': 1 } });
  configure({ ...makeProfile(), recipe: { id: 'current-recipe', version: '9.0' } });
  const details = await presentation.details(p._id);
  expect(details.recipe.declaredIdentity).toBeUndefined(); expect(details.execution).toBeUndefined();
});

test.each(['missing', 'changed-bytes'])('a non-null acknowledged write with %s graph data cannot dispatch', async mode => {
  const collection = ImageOperation.collection;
  const originalWrite = collection.findOneAndUpdate.bind(collection); let changed = false;
  jest.spyOn(collection, 'findOneAndUpdate').mockImplementation((filter, update, ...args) => {
    if (!changed && update.$set?.execution) {
      changed = true;
      const set = { ...update.$set };
      if (mode === 'missing') delete set.execution;
      else {
        const execution = set.execution;
        set.execution = { ...execution, graph: { ...execution.graph, save: { ...execution.graph.save,
          inputs: { ...execution.graph.save.inputs, filename_prefix: 'fixture/changed-after-preparation' } } } };
      }
      return originalWrite(filter, { ...update, $set: set }, ...args);
    }
    return originalWrite(filter, update, ...args);
  });
  const accepted = await service.accept(body()); await terminal(accepted.id);
  expect(changed).toBe(true); expect(client.submit).not.toHaveBeenCalled();
});
