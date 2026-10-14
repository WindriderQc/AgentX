'use strict';
const { create } = require('../../public/js/image-reference-selection');
const checksum = letter => letter.repeat(64);
function fixture() {
  const first = {}, second = {}, guide = {}, parent = { operationId: 'parent-one', sha256: checksum('a') };
  let selection = { epoch: 1, parent, files: [first], sketch: null };
  const prepared = (base64, sha256) => ({ base64, sha256, mimeType: 'image/jpeg', bytes: 4, width: 2, height: 2 });
  const file = jest.fn(async value => prepared(value === first ? 'Zmlyc3Q=' : 'c2Vjb25k', checksum(value === first ? 'b' : 'c')));
  const sketch = jest.fn(async () => ({ ...prepared('c2tldGNo', checksum('d')), mimeType: 'image/png' }));
  const upload = jest.fn(async (session, value, kind) => ({ kind, attachmentId: `${session}-${value.sha256[0]}`, sha256: value.sha256,
    mimeType: value.mimeType, byteLength: value.bytes, width: value.width, height: value.height, transform: 'browser-working-copy-v1' }));
  const resolve = jest.fn(async (_session, values) => values.map((value, position) => ({ ...value, position })));
  const manager = create({ getSelection: () => selection, file, sketch, upload, resolve });
  return { manager, file, sketch, upload, resolve, first, second, guide, parent, set: value => { selection = value; } };
}

test('inspection and rendering reuse the exact prepared bytes once in parent/upload order', async () => {
  const ui = fixture(), render = await ui.manager.render(), manifest = await ui.manager.inspect('discussion');
  expect(manifest.map(value => value.kind)).toEqual(['parent', 'upload']);
  expect(ui.file).toHaveBeenCalledTimes(1);
  expect(ui.upload).toHaveBeenCalledWith('discussion', expect.objectContaining({ base64: render.references[0] }), 'upload', ui.first);
  expect(await ui.manager.render()).toEqual({ ...render, referenceSelection: manifest });
  expect(await ui.manager.inspect('discussion')).toEqual(manifest);
  expect(ui.upload).toHaveBeenCalledTimes(1); expect(ui.resolve).toHaveBeenCalledTimes(1);
});

test('uploads stay in input order and the composition sketch is last', async () => {
  const ui = fixture(); ui.set({ epoch: 1, files: [ui.first], sketch: ui.guide });
  const manifest = await ui.manager.inspect('discussion');
  expect(manifest.map(value => [value.position, value.kind])).toEqual([[0, 'upload'], [1, 'sketch']]);
  expect((await ui.manager.render()).references).toEqual(['Zmlyc3Q=', 'c2tldGNo']);
  expect(ui.sketch).toHaveBeenCalledTimes(1);
});
test('a parent followed by a sketch keeps the archived parent outside the uploaded render byte array', async () => {
  const ui = fixture(); ui.set({ epoch: 1, parent: ui.parent, files: [], sketch: ui.guide });
  const references = await ui.manager.inspect('discussion');
  expect(references.map(value => [value.position, value.kind])).toEqual([[0, 'parent'], [1, 'sketch']]);
  expect(await ui.manager.render()).toEqual({ parent: ui.parent, references: ['c2tldGNo'], referenceSelection: references });
  expect(ui.file).not.toHaveBeenCalled();
});

test('replacement and reorder of an equal-count selection cannot reuse a proposal', async () => {
  const ui = fixture(); ui.set({ epoch: 1, files: [ui.first, ui.second] });
  const original = await ui.manager.inspect('discussion'); expect(ui.manager.matches(original)).toBe(true);
  ui.set({ epoch: 1, files: [ui.second, ui.first] });
  expect(ui.manager.matches(original)).toBe(false); expect(ui.manager.current()).toBeNull();
  const reordered = await ui.manager.inspect('discussion');
  expect(reordered.map(value => value.sha256)).toEqual([checksum('c'), checksum('b')]);
  expect(ui.upload).toHaveBeenCalledTimes(2); expect(ui.file).toHaveBeenCalledTimes(2);
});

test('a fresh browser controller cannot claim that a prior persisted proposal matches unknown current bytes', async () => {
  const original = await fixture().manager.inspect('discussion'), reloaded = fixture();
  expect(reloaded.manager.matches(original)).toBe(false);
  await reloaded.manager.inspect('discussion'); expect(reloaded.manager.matches(original)).toBe(true);
  reloaded.set({ epoch: 2, parent: { ...reloaded.parent, operationId: 'parent-two' }, files: [reloaded.first] });
  expect(reloaded.manager.matches(original)).toBe(false);
});

test('selection change during decoding refuses before attachment or native dispatch', async () => {
  const ui = fixture(); let release;
  ui.file.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const run = ui.manager.inspect('discussion'); await Promise.resolve();
  ui.set({ epoch: 2, files: [ui.second] }); release({ base64: 'Zmlyc3Q=', bytes: 4, sha256: checksum('b') });
  await expect(run).rejects.toThrow('references changed');
  expect(ui.upload).not.toHaveBeenCalled(); expect(ui.resolve).not.toHaveBeenCalled();
});

test('selection change during scoped upload refuses before resolving or inspecting another selection', async () => {
  const ui = fixture(); let release;
  ui.upload.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const run = ui.manager.inspect('discussion');
  while (!release) await Promise.resolve();
  ui.set({ epoch: 2, files: [ui.second] }); release({ kind: 'upload', attachmentId: 'first', sha256: checksum('b') });
  await expect(run).rejects.toThrow('references changed'); expect(ui.resolve).not.toHaveBeenCalled();
});

test('oversized and too-many selections refuse without uploading or dropping an image', async () => {
  const ui = fixture(); ui.set({ epoch: 1, parent: ui.parent, files: [ui.first], sketch: ui.guide });
  await expect(ui.manager.inspect('discussion')).rejects.toThrow('Two references');
  expect(ui.file).not.toHaveBeenCalled();
  ui.set({ epoch: 2, files: [ui.first] });
  ui.file.mockResolvedValue({ base64: 'Zmlyc3Q=', sha256: checksum('b'), bytes: 3 * 1024 * 1024 + 1 });
  await expect(ui.manager.inspect('discussion')).rejects.toThrow('3 MiB'); expect(ui.upload).not.toHaveBeenCalled();
});

test('resolver drift refuses and failed upload preserves exact render bytes for a deliberate later action', async () => {
  const ui = fixture(); ui.upload.mockRejectedValueOnce(new Error('Original unavailable'));
  await expect(ui.manager.inspect('discussion')).rejects.toThrow('Original unavailable');
  expect((await ui.manager.render()).references).toEqual(['Zmlyc3Q=']); expect(ui.file).toHaveBeenCalledTimes(1);
  ui.resolve.mockResolvedValue([{ kind: 'parent', operationId: 'other', sha256: checksum('a') }, { kind: 'upload', attachmentId: 'other', sha256: checksum('b') }]);
  await expect(ui.manager.inspect('discussion')).rejects.toThrow('receipt is incomplete or changed'); expect(ui.manager.current()).toBeNull();
});
