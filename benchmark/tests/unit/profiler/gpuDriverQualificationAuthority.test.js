'use strict';
const { assertQualificationAuthority } = require('../../../src/services/profiler/gpuDriverQualificationAuthority');
const proof = { workloadId: 'tool-synthetic', workloadAdmissionId: 'admission', workloadGeneration: 'generation',
  claimBatchId: 'tool-synthetic', claimGeneration: 'claim-generation' };

test('Benchmark re-attests exact Core claim authority instead of trusting caller attribution', async () => {
  const request = jest.fn(async () => ({ data: { heartbeat: true, batchId: proof.workloadId,
    claimGeneration: proof.claimGeneration, snapshotExact: true } }));
  await expect(assertQualificationAuthority('http://synthetic.example:11434', proof, { request })).resolves.toMatchObject({ heartbeat: true });
  const sent = JSON.parse(request.mock.calls[0][1].body);
  expect(sent).toEqual({ admissionId: proof.workloadAdmissionId, admissionGeneration: proof.workloadGeneration, claimGeneration: proof.claimGeneration });
  for (const altered of [{ ...proof, claimBatchId: 'another-workload' }, { ...proof, workloadGeneration: null }]) {
    await expect(assertQualificationAuthority('http://synthetic.example:11434', altered, { request }))
      .rejects.toMatchObject({ code: 'GPU_DRIVER_QUALIFICATION_AUTHORITY_REQUIRED' });
  }
  expect(request).toHaveBeenCalledTimes(1);
});

test.each([{ heartbeat: false }, { heartbeat: true, batchId: 'another-workload' },
  { heartbeat: true, batchId: proof.workloadId, claimGeneration: 'changed', snapshotExact: true },
  { heartbeat: true, batchId: proof.workloadId, claimGeneration: proof.claimGeneration, snapshotExact: false }])
('Core refusal or replaced generation does not return prepared authority: %j', async receipt => {
  await expect(assertQualificationAuthority('http://synthetic.example:11434', proof,
    { request: async () => ({ data: receipt }) })).rejects.toMatchObject({ code: 'GPU_DRIVER_QUALIFICATION_AUTHORITY_REQUIRED' });
});
