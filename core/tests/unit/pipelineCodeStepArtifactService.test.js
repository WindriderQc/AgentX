'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createPipelineCodeStepArtifactService, MAX_BYTES } = require('../../src/services/pipelineCodeStepArtifactService');

const owner = {
  pipelineId: '0946',
  graphId: '11111111-1111-4111-8111-111111111111',
  stepId: 'step-01',
  requestId: '22222222-2222-4222-8222-222222222222',
};
const bundle = Buffer.from('# v2 git bundle\nsynthetic cpu fixture\n');

describe('pipeline code-step artifact service', () => {
  let directory;
  let service;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-code-step-artifacts-'));
    service = createPipelineCodeStepArtifactService({ dir: directory });
  });

  afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

  test('stores, verifies, reads, and replays one immutable bundle', async () => {
    const first = await service.store(owner, bundle);
    expect(first).toMatchObject({ format: 'git-bundle/v1', sizeBytes: bundle.length, replayed: false });
    expect(first.id).toMatch(/^code-step-[a-f0-9]{40}$/);
    const loaded = await service.read(first.id);
    expect(loaded.bytes).toEqual(bundle);
    expect(loaded.metadata.owner).toEqual(owner);
    await expect(service.store(owner, bundle)).resolves.toMatchObject({ id: first.id, replayed: true });
  });

  test('refuses a divergent replay, malformed payload, and oversized bundle', async () => {
    await service.store(owner, bundle);
    await expect(service.store(owner, Buffer.from('# v2 git bundle\ndifferent\n')))
      .rejects.toMatchObject({ code: 'CODE_STEP_ARTIFACT_CONFLICT', statusCode: 409 });
    await expect(service.store({ ...owner, requestId: '33333333-3333-4333-8333-333333333333' }, Buffer.from('not a bundle')))
      .rejects.toMatchObject({ code: 'CODE_STEP_ARTIFACT_INVALID' });
    await expect(service.store({ ...owner, requestId: '44444444-4444-4444-8444-444444444444' },
      Buffer.concat([Buffer.from('# v2 git bundle\n'), Buffer.alloc(MAX_BYTES)])))
      .rejects.toMatchObject({ code: 'CODE_STEP_ARTIFACT_TOO_LARGE', statusCode: 413 });
  });

  test('detects bytes changed after storage', async () => {
    const stored = await service.store(owner, bundle);
    await fs.writeFile(path.join(directory, `${stored.id}.bundle`), Buffer.from('# v2 git bundle\ntampered\n'));
    await expect(service.read(stored.id)).rejects.toMatchObject({ code: 'CODE_STEP_ARTIFACT_UNAVAILABLE', statusCode: 503 });
  });
});
