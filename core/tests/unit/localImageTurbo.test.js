'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { workflow } = require('../../src/services/images/workflows');
const { buildExecution } = require('../../src/services/images/recipeExecution');
const { validateGraph } = require('../../src/services/images/exportGraphV2');
const { sha } = require('../../src/services/images/exportGraphV1');
const { loadConfig } = require('../../src/services/images/config');
const { describe } = require('../../src/services/images/workshopPresentation');
const id = '11111111-1111-4111-8111-111111111111';
const profile = { family: 'qwen21', sampling: 'qwen21-turbo', diffusion: 'qwen_image_2.1_turbo_bf16.safetensors',
  encoder: 'qwen3vl_8b_bf16.safetensors', vae: 'qwen_image_2.1_vae_bf16.safetensors', steps: 8, maxPixels: 4300800,
  label: 'Qwen 2.1 Turbo', recipe: { id: 'qwen21-turbo-bf16-8', version: '1' } };
const request = { prompt: 'Synthetic robot scene', seed: 42, width: 2400, height: 1792 };
const schedule = '1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0';
test.each([0, 1, 2])('Turbo uses its checkpoint schedule and correct latent with %i references', count => {
  const refs = Array.from({ length: count }, (_, i) => `agentx-${id}-${i}.png`);
  const graph = workflow(profile, { ...request, sigmas: [1, 0], steps: 1 }, refs, id);
  expect(graph.model.inputs.unet_name).toBe(profile.diffusion);
  expect(graph.sigmas).toEqual({ class_type: 'ManualSigmas', inputs: { sigmas: schedule } });
  expect(graph.noise.inputs.noise_seed).toBe(42); expect(graph.guider.inputs.cfg).toBe(1);
  expect(graph.guider.inputs.model).toEqual(['cache', 0]);
  expect(graph.sampler.inputs.sampler_name).toBe('euler');
  expect(graph.sample.class_type).toBe('SamplerCustomAdvanced');
  expect(graph.sample.inputs.latent_image).toEqual(count ? ['text', 2] : ['latent', 0]);
  expect(graph.text.inputs.resolution).toBe(count ? 2048 : 2080);
  refs.forEach((name, i) => expect(graph[`ref${i}`].inputs.image).toBe(name));
  const execution = buildExecution(profile, request, refs, id);
  expect(execution.builder.version).toBe(2);
  expect(validateGraph({ _id: id, profile, request, execution }, count)).toEqual(Buffer.from(JSON.stringify(graph)));
});
test('classic Qwen keeps its simple scheduler and builder v1', () => {
  const classic = { ...profile, sampling: undefined, steps: 25, diffusion: 'qwen_image_2.1_bf16.safetensors' };
  const e = buildExecution(classic, request, [], id);
  expect(e.builder.version).toBe(1);
  expect(e.graph.sample).toMatchObject({ class_type: 'KSampler', inputs: { steps: 25, scheduler: 'simple', sampler_name: 'euler' } });
  expect(e.graph.sigmas).toBeUndefined();
});
test.each([{ steps: 7 }, { steps: 25 }, { family: 'klein' }, { sampling: 'custom' }, { sampling: null }, { sampling: { sigmas: [1, 0] } }])
  ('invalid Turbo configuration %j refuses instead of silently running another schedule', extra => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-config-')), previous = process.env.LOCAL_IMAGES_CONFIG;
    try {
      const file = path.join(directory, 'config.json');
      fs.writeFileSync(file, JSON.stringify({ workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'],
        defaultProfile: 'turbo', profiles: { turbo: { ...profile, ...extra } } }));
      process.env.LOCAL_IMAGES_CONFIG = file;
      expect(() => loadConfig()).toThrow(/Turbo/);
      expect(() => workflow({ ...profile, ...extra }, request, [], id)).toThrow(/Turbo/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      if (previous === undefined) delete process.env.LOCAL_IMAGES_CONFIG; else process.env.LOCAL_IMAGES_CONFIG = previous;
    }
  });
test('Turbo advertises all seven Qwen formats, recorded identity and first-reference framing', () => {
  expect(describe({ profiles: { turbo: profile } }).profiles[0]).toMatchObject({ id: 'turbo', sampling: 'qwen21-turbo',
    steps: 8, maxPixels: 4300800, editingFraming: 'first-reference', declaredIdentity: profile.recipe });
  expect(describe({ profiles: { turbo: profile } }).profiles[0].sizes).toHaveLength(7);
});
test.each([
  ['changed sigma', op => { op.execution.graph.sigmas.inputs.sigmas = '1, 0'; }],
  ['changed seed', op => { op.execution.graph.noise.inputs.noise_seed++; }],
  ['wrong CFG', op => { op.execution.graph.guider.inputs.cfg = 7; }],
  ['wrong sampler', op => { op.execution.graph.sampler.inputs.sampler_name = 'heun'; }],
  ['unbound reference', op => { op.execution.graph.ref0.inputs.image = 'foreign.png'; }],
  ['extra node', op => { op.execution.graph.foreign = { class_type: 'Unknown', inputs: {} }; }],
  ['wrong steps', op => { op.profile.steps = 25; op.execution.parameters.steps = 25; }],
  ['wrong sampling', op => { delete op.profile.sampling; }],
  ['wrong builder', op => { op.execution.builder.version = 1; }],
])('a recomputed SHA cannot export a Turbo graph with %s', (_label, mutate) => {
  const op = { _id: id, profile: structuredClone(profile), request: { ...request },
    execution: buildExecution(profile, request, [`agentx-${id}-0.png`], id) };
  mutate(op); op.execution.graphSha256 = sha(JSON.stringify(op.execution.graph));
  expect(() => validateGraph(op, 1)).toThrow(expect.objectContaining({ statusCode: 503 }));
});
