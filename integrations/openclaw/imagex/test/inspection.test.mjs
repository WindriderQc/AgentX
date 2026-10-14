import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateInspection } from '../inspection.mjs';
import { invokeStudio } from '../studio.mjs';
const fixture = () => {
  const references = [{ kind: 'upload', attachmentId: '1'.repeat(24), sha256: 'a'.repeat(64), position: 0,
    mimeType: 'image/png', byteLength: 123, width: 32, height: 32 }];
  const referenceSha256 = createHash('sha256').update(JSON.stringify(references)).digest('hex');
  return { action: 'plan', request: { prompt: 'Preserve full brief', inspectReferences: true, references },
    referenceInspection: { version: 1, source: 'openclaw-main', referenceSha256, references, analysis: 'A blue square; text uncertain.',
      nativeReceipt: { source: 'openclaw', mode: 'agent', requestId: '11111111-1111-4111-8111-111111111111',
        runId: 'native-fixture', completion: 'completed', requested: { agentId: 'main' } } } };
};
test('gateway accepts only bounded completed Main evidence bound to the exact ordered set', () => {
  validateInspection(fixture()); validateInspection({ action: 'consult', context: {}, prompt: 'Text only' });
  for (const mutate of [
    input => { delete input.referenceInspection; },
    input => { input.referenceInspection.nativeReceipt.requested.agentId = 'other'; },
    input => { input.referenceInspection.nativeReceipt.completion = 'unknown'; },
    input => { input.referenceInspection.references[0].base64 = 'raw-bytes'; },
    input => { input.referenceInspection.references[0].path = '/private/path'; },
    input => { input.referenceInspection.referenceSha256 = 'b'.repeat(64); },
    input => { input.referenceInspection.analysis = 'x'.repeat(16001); },
    input => { input.referenceInspection.nativeReceipt.token = 'private'; },
    input => { input.request.references = []; }
  ]) { const input = fixture(); mutate(input); assert.throws(() => validateInspection(input), /Invalid verified/); }
});
test('malformed inspection refuses before any native Hermes process is started', () => {
  const input = fixture(); input.referenceInspection.analysis = 'x'.repeat(16001);
  let spawned = false;
  assert.throws(() => invokeStudio('/fixture/worker', input, { spawnImpl: () => { spawned = true; } }), /Invalid verified/);
  assert.equal(spawned, false);
});
