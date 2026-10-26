/**
 * Synthetic source qualification against an explicitly supplied DSH runtime.
 * Only a newly created temporary package copy is patched. No session data,
 * native services, models, package installation or network requests are used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--runtime-root' || !args[1]) {
  throw new Error('Usage: node dsh-session-compat-semantics.mjs --runtime-root /path/to/dsh');
}
const runtimeRoot = resolve(args[1]);
const runtimeManifest = pathToFileURL(join(runtimeRoot, 'package.json'));
const runtimeRequire = createRequire(runtimeManifest);
const runtimeVersion = JSON.parse(readFileSync(runtimeRequire.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version;
assert.ok(['0.2.0-rc.2', '0.2.1-rc.3'].includes(runtimeVersion), 'Only reviewed upstream releases are qualified');
const targetPackage = '@deepseek-ai/dsh-session-format-v0-to-v1';
const requiredPackages = [
  '@deepseek-ai/dsh-session-format', targetPackage,
  '@deepseek-ai/dsh-session-format-catalog',
  '@deepseek-ai/dsh-session-format-v3-to-v4', '@deepseek-ai/dsh-subagent',
];
for (const name of requiredPackages) {
  const manifest = JSON.parse(readFileSync(runtimeRequire.resolve(`${name}/package.json`), 'utf8'));
  assert.equal(manifest.name, name, 'Exact upstream package required');
  assert.equal(manifest.version, runtimeVersion, 'All migration packages must match the reviewed runtime');
}
const packageRoot = dirname(runtimeRequire.resolve(`${targetPackage}/package.json`));
const disposableRoot = mkdtempSync(join(tmpdir(), 'dsh-session-compat-semantics-'));
process.once('exit', () => rmSync(disposableRoot, { recursive: true, force: true }));
mkdirSync(join(disposableRoot, 'lib'));
writeFileSync(join(disposableRoot, 'package.json'), readFileSync(join(packageRoot, 'package.json')));
writeFileSync(join(disposableRoot, 'lib/index.js'), readFileSync(join(packageRoot, 'lib/index.js')));
const installer = fileURLToPath(new URL('./dsh-session-compat.py', import.meta.url));
const applied = spawnSync('python3', [installer, '--package-root', disposableRoot, '--apply'], {
  encoding: 'utf8', timeout: 10000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(applied.error, undefined, 'Disposable installer must complete');
assert.equal(applied.status, 0, `Disposable installer refused: ${applied.stderr}`);
const receipt = JSON.parse(applied.stdout);
assert.ok(receipt.ok && ['applied', 'already_applied'].includes(receipt.state));
const candidateUrl = pathToFileURL(join(disposableRoot, 'lib/index.js')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === targetPackage) return { url: candidateUrl, shortCircuit: true };
    if (specifier.startsWith('@deepseek-ai/')) {
      return next(specifier, { ...context, parentURL: runtimeManifest.href });
    }
    return next(specifier, context);
  },
});
const { SessionFormatEventCollector } = await import('@deepseek-ai/dsh-session-format');
const { assertReleasedEventPayload, assertReleasedPayloadSemantics,
  releasedV0SessionFormatCodec, sessionFormatV0ToV1 } = await import(targetPackage);
const { createSessionFormatCatalogWithChildren } = await import('@deepseek-ai/dsh-session-format-catalog');
const { historicalChildCatalogSource } = await import('@deepseek-ai/dsh-session-format-v3-to-v4');
const { foldSubagentDescriptor } = await import('@deepseek-ai/dsh-subagent');

const publishedSubagent = await readFile(runtimeRequire.resolve('@deepseek-ai/dsh-subagent'), 'utf8');
const projectionSource = publishedSubagent.slice(publishedSubagent.indexOf('const subagentIdentityProjectionDefinition = {'), publishedSubagent.indexOf('//#endregion', publishedSubagent.indexOf('const subagentIdentityProjectionDefinition = {')));
assert.ok(projectionSource.startsWith('const subagentIdentityProjectionDefinition'));
const identitySource = publishedSubagent.slice(publishedSubagent.indexOf('function descriptorIdentity(event) {'), publishedSubagent.indexOf('/**', publishedSubagent.indexOf('function descriptorIdentity(event) {')));
const projection = new Function('foldSubagentDescriptor', 'identityStateSchema', 'identitySchema', identitySource + projectionSource + '\nreturn subagentIdentityProjectionDefinition;')(foldSubagentDescriptor, null, null);

const event = data => ({ type: 'subagent/descriptor', seq: 0, time: 2, data });
const sourceHeader = { version: 0, id: 'synthetic-child', createdAt: 1, isSeeded: false, delegationDepth: 1, parentSession: 'synthetic-parent', origin: 'subagent' };
const physicalHeader = { ...sourceHeader, type: 'session' };
delete physicalHeader.isSeeded;
function transform(data) {
  const row = event(data);
  const stage = sessionFormatV0ToV1.createStage({ sourceHeader, targetHeader: sessionFormatV0ToV1.migrateHeader(sourceHeader), sourceInheritedEventCount: 0, sourceKind: 'decoded' });
  const output = new SessionFormatEventCollector();
  stage.transformEvent(row, output);
  stage.finish(output);
  return output.values[0];
}
function fullRestore(data) {
  const restore = createSessionFormatCatalogWithChildren([]).createRestore(physicalHeader, { recovery: 'strict', validation: 'transformed' });
  restore.decodeRow(event(data));
  return restore.finish();
}
const validV2 = [
  { version: 2, mode: 'one-shot', provider: 'provider-registry' },
  { version: 2, mode: 'one-shot', provider: '', label: '' },
  { version: 2, mode: 'continuable', provider: 'provider-registry', label: 'synthetic child' },
  { version: 2, mode: 'continuable', provider: '', label: '', agentProvider: '' },
  { version: 2, mode: 'continuable', provider: 'registry', label: 'child', agentModel: '' },
  { version: 2, mode: 'continuable', provider: 'registry', label: 'child', agentProvider: 'route-provider', agentModel: 'model-alias', persona: '', toolFilter: { allow: [], deny: ['', 'shell'] } },
];

for (const [index, data] of validV2.entries()) {
  test(`released v2 case ${index} preserves every field through the complete v0-to-v4 chain`, () => {
    const before = structuredClone(data);
    assert.doesNotThrow(() => assertReleasedEventPayload(event(data), 0));
    assert.doesNotThrow(() => assertReleasedPayloadSemantics(event(data), 2));
    const collector = new SessionFormatEventCollector();
    const decoder = releasedV0SessionFormatCodec.createDecoder(physicalHeader, 'strict');
    decoder.decodeRow(event(data), collector);
    decoder.finish(collector);
    assert.deepEqual(collector.values[0].data, data);
    assert.deepEqual(transform(data).data, data);
    const restored = fullRestore(data);
    assert.equal(restored.header.version, 4);
    assert.deepEqual(restored.events.find(row => row.type === 'subagent/descriptor').data, data);
    assert.deepEqual(data, before);
    assert.equal(foldSubagentDescriptor(restored.events), undefined);
    const state = projection.apply(projection.init(), event(data));
    assert.equal(projection.wire.view(state), null);
    assert.equal(Object.hasOwn(restored.events[0].data, 'agentReasoningEffort'), false);
  });
}

test('current v3 descriptor and current native identity remain unchanged', () => {
  const data = { version: 3, mode: 'continuable', provider: 'registry', label: 'child', agentProvider: 'route-provider', agentModel: 'model-alias', agentReasoningEffort: 'high', toolFilter: { allow: ['read'] } };
  const restored = fullRestore(data);
  assert.deepEqual(restored.events[0].data, data);
  assert.deepEqual(foldSubagentDescriptor(restored.events), data);
  assert.deepEqual(projection.wire.view(projection.apply(projection.init(), restored.events[0])), { mode: 'continuable', label: 'child', seq: 0 });
});

test('provider registry identity remains separate from optional agent route fields', () => {
  const data = { version: 2, mode: 'continuable', provider: 'subagent-driver', label: 'child', agentProvider: 'different-route', agentModel: 'chosen-model' };
  assert.deepEqual(fullRestore(data).events[0].data, data);
});

test('historical parent catalog retains the v2 child mode and label without enabling runtime identity', () => {
  const data = { version: 2, mode: 'continuable', provider: 'registry', label: 'legacy child' };
  const child = fullRestore(data);
  const evidence = historicalChildCatalogSource(child);
  assert.deepEqual(evidence.descriptor, data);
  const catalog = createSessionFormatCatalogWithChildren([evidence]);
  const parentHeader = { type: 'session', version: 0, id: 'synthetic-parent', createdAt: 0, delegationDepth: 0 };
  const parent = catalog.createRestore(parentHeader, { recovery: 'strict', validation: 'transformed' }).finish();
  const fact = parent.events.find(row => row.type === 'subagent/catalog');
  assert.ok(fact, 'Full parent migration must retain child discovery');
  assert.equal(fact.data.childId, 'synthetic-child');
  assert.equal(fact.data.label, data.label);
  assert.equal(fact.data.mode, data.mode);
});

test('future and unsupported v0 descriptor versions still refuse instead of becoming v2', () => {
  for (const version of [1, 4, 99, '2', null]) {
    assert.throws(() => fullRestore({ version, mode: 'one-shot', provider: 'registry' }));
  }
});

test('v2 unknown fields and malformed values are refused by both decoder and downstream semantics', () => {
  const base = { version: 2, mode: 'continuable', provider: 'registry', label: 'child' };
  const malformed = [
    { ...base, agentReasoningEffort: 'high' }, { ...base, future: true },
    { ...base, version: '2' }, { ...base, mode: 'future' }, { ...base, provider: 1 },
    { ...base, label: null }, { ...base, agentProvider: 3 }, { ...base, agentModel: false },
    { ...base, persona: [] }, { ...base, toolFilter: {} },
    { ...base, toolFilter: { allow: ['read'], future: true } },
    { ...base, toolFilter: { allow: [null] } }, { ...base, toolFilter: { deny: 'read' } },
    { version: 2, mode: 'one-shot', provider: 'registry', agentProvider: 'forbidden' },
    { version: 2, mode: 'continuable', provider: 'registry' },
  ];
  for (const data of malformed) {
    assert.throws(() => fullRestore(data));
    if (data.version === 2) assert.throws(() => assertReleasedPayloadSemantics(event(data), 2));
  }
});

test('unrelated events, unsupported plugin vocabulary and v3 strict validation stay unchanged', () => {
  const stage = sessionFormatV0ToV1.createStage({ sourceHeader, targetHeader: sessionFormatV0ToV1.migrateHeader(sourceHeader), sourceInheritedEventCount: 0, sourceKind: 'decoded' });
  const output = new SessionFormatEventCollector();
  const unrelated = { type: 'feedback/record', seq: 0, time: 2, data: { text: 'synthetic retained text' } };
  stage.transformEvent(unrelated, output);
  assert.deepEqual(output.values, [unrelated]);
  assert.throws(() => assertReleasedEventPayload({ ...unrelated, type: 'third-party/event', ignorable: true }, 0));
  assert.throws(() => fullRestore({ version: 3, mode: 'continuable', provider: 'registry', label: 'child', agentProvider: 'unpaired' }));
});
