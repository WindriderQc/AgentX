'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { catalogue, prepare } = require('../../src/services/images/labIntent');
const SHA = 'a'.repeat(64), PARENT = 'b'.repeat(64), GRAPH = 'c'.repeat(64);
let dir;
const put = (id, data) => fs.writeFileSync(path.join(dir, 'lab-resources/ready/recipes', id + '.json'), JSON.stringify(data));
const fixture = (id, entries) => ({ id, title: 'Synthetic recipes', schemaVersion: 1, live: true, automaticDispatch: true,
  records: id === 'finish16' ? [] : entries, maxRuns: id === 'finish16' ? entries : [],
  host: 'private-host', componentManifest: { path: '/private/manifest' }, integration: { qualified: true } });
function body(id = 'scenes', entryIndex = 0) {
  const c = catalogue(id, dir), selected = c.entries[entryIndex];
  return { labSelection: { catalogueId: c.id, catalogueSha256: c.sha256, kind: selected.kind, entryId: selected.id },
    prompt: 'Keep three characters around the table.', width: 2400, height: 1792, seed: 42, approvedElements: 'Keep the shared brush.' };
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-intent-'));
  fs.mkdirSync(path.join(dir, 'lab-resources/ready/recipes'), { recursive: true });
  put('scenes', fixture('scenes', [{ id: 'scene-40', title: 'Forty steps', width: 2400, height: 1792, seed: 42, steps: 40,
    sha256: SHA, graphSHA256: GRAPH, parents: [], parameters: { cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 },
    graph: '/private/graph', components: [{ nodeType: 'Loader', file: 'model.safetensors', provenance: { sha256: SHA, revision: 'revision-1', path: '/private/weight' } }] }]));
  put('edit', fixture('edit', [{ id: 'edit-4', steps: 4, seed: 42, parents: [PARENT], parameters: {} }]));
  put('finish16', fixture('finish16', [{ id: 'refine-025', role: 'refine', denoise: 0.25, seed: 42, parentSHA256: PARENT },
    { id: 'native', role: 'native', denoise: 1, seed: 42, parentSHA256: null }]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
test('pins actual catalogue bytes, projects known parameters and drops private locations and qualification flags', () => {
  const c = catalogue('scenes', dir);
  const bytes = fs.readFileSync(path.join(dir, 'lab-resources/ready/recipes/scenes.json'));
  expect(c.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
  expect(c.entries[0]).toMatchObject({ parameters: { seed: 42, steps: 40, cfg: 1, denoise: 1 }, graphSha256: GRAPH,
    components: [{ sha256: SHA, revision: 'revision-1' }] });
  expect(JSON.stringify(c)).not.toMatch(/private|qualified|live/);
  expect(c.automaticDispatch).toBe(false);
});
test('preserves incomplete four-step edit evidence and separates human request from historical parameters', () => {
  const request = body('edit'); request.seed = 1729;
  const plan = prepare(request, dir);
  expect(plan).toMatchObject({ state: 'prepared_only', automaticDispatch: false, operation: 'reference_edit',
    request: { seed: 1729, approvedElements: request.approvedElements }, evidence: { declaredParentSha256: [PARENT],
      parameters: { seed: 42, steps: 4, cfg: null, sampler_name: null, scheduler: null, denoise: null }, graphSha256: null } });
  expect(plan.evidence).not.toHaveProperty('coreParent');
  expect(plan).not.toHaveProperty('recipeId'); expect(plan).not.toHaveProperty('execution');
});
test('a native MAX creation remains parentless and distinct from low-noise refinement; undocumented steps stay unknown', () => {
  const refine = prepare(body('finish16'), dir), native = prepare(body('finish16', 1), dir);
  expect(refine).toMatchObject({ operation: 'reference_finish', evidence: { declaredParentSha256: [PARENT], parameters: { denoise: 0.25, steps: null } } });
  expect(native).toMatchObject({ operation: 'text_to_image', evidence: { declaredParentSha256: [], parameters: { denoise: 1, steps: null } } });
  expect(native.id).not.toBe(refine.id);
});
test('catalogue changes and wrong entry identities refuse instead of choosing another recipe', () => {
  const request = body(); fs.appendFileSync(path.join(dir, 'lab-resources/ready/recipes/scenes.json'), '\n');
  expect(() => prepare(request, dir)).toThrow('Le catalogue a changé');
  request.labSelection.catalogueSha256 = catalogue('scenes', dir).sha256; request.labSelection.entryId = 'missing';
  expect(() => prepare(request, dir)).toThrow('Cette entrée');
});
test.each(['graph', 'parent', 'qualified', 'workerUrl'])('refuses caller-supplied %s without inventing an execution contract', key => {
  expect(() => prepare({ ...body(), [key]: 'untrusted' }, dir)).toThrow('Intention');
});
test.each([{ width: 16384 }, { height: 257 }, { seed: -1 }, { prompt: '' }, { approvedElements: 'x'.repeat(2001) }])('bounds human request fields: %o', changes => {
  expect(() => prepare({ ...body(), ...changes }, dir)).toThrow();
});
test('rejects unknown paths, absent data, oversized catalogues, incompatible schema and duplicate entries', () => {
  expect(() => catalogue('../scenes', dir)).toThrow('Catalogue inconnu');
  expect(() => catalogue('scenes', null)).toThrow('indisponibles');
  put('scenes', { schemaVersion: 2 }); expect(() => catalogue('scenes', dir)).toThrow('incompatible');
  put('scenes', fixture('scenes', [{ id: 'same' }, { id: 'same' }])); expect(() => catalogue('scenes', dir)).toThrow('ambiguë');
  fs.writeFileSync(path.join(dir, 'lab-resources/ready/recipes/scenes.json'), Buffer.alloc(2 * 1024 * 1024 + 1));
  expect(() => catalogue('scenes', dir)).toThrow('indisponibles');
});
test('a catalogue symlink or directory is refused before opening a descriptor', () => {
  const filename = path.join(dir, 'lab-resources/ready/recipes/scenes.json');
  fs.renameSync(filename, filename + '.saved'); fs.symlinkSync(filename + '.saved', filename);
  const open = jest.spyOn(fs, 'openSync');
  try { expect(() => catalogue('scenes', dir)).toThrow('indisponibles'); expect(open).not.toHaveBeenCalled(); }
  finally { open.mockRestore(); }
  fs.unlinkSync(filename); fs.mkdirSync(filename);
  expect(() => catalogue('scenes', dir)).toThrow('indisponibles');
});
test.each([{ id: 'bad', role: 'refine' }, { id: 'bad', role: 'native', parentSHA256: PARENT }, { id: 'bad', role: 'other' }])('rejects inconsistent MAX role/parent evidence: %o', record => {
  put('finish16', fixture('finish16', [record])); expect(() => catalogue('finish16', dir)).toThrow();
});
test('unsafe or string numeric evidence is refused, and a scene never acquires a refinement role', () => {
  for (const change of [{ seed: 2 ** 53 }, { width: '<img onerror=alert(1)>' }, { role: 'refine', parents: [PARENT] }]) {
    put('scenes', fixture('scenes', [{ id: 'bad', ...change }])); expect(() => catalogue('scenes', dir)).toThrow();
  }
});
