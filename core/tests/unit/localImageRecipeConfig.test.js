'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../../src/services/images/config');
const { describe } = require('../../src/services/images/workshopPresentation');
const baseProfile = { family: 'klein', diffusion: 'fixture.safetensors', encoder: 'encoder.safetensors', vae: 'vae.safetensors', steps: 4, maxPixels: 4194304 };
let directory, previous;
function read(recipe, include = true) {
  const config = { workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'], defaultProfile: 'quality',
    profiles: { quality: { ...baseProfile, ...(include && { recipe }) } } };
  const file = path.join(directory, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(config));
  process.env.LOCAL_IMAGES_CONFIG = file; return loadConfig();
}
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-config-fixture-')); previous = process.env.LOCAL_IMAGES_CONFIG; });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.LOCAL_IMAGES_CONFIG; else process.env.LOCAL_IMAGES_CONFIG = previous; });
test.each([null, [], {}, { id: 'fixture' }, { id: 'fixture', version: 1 }, { id: '', version: '1' },
  { id: 'bad recipe', version: '1' }, { id: 'fixture', version: '' }, { id: 'fixture', version: 'v 1' },
  { id: 'a'.repeat(81), version: '1' }, { id: 'fixture', version: '1'.repeat(81) },
  { id: 'fixture', version: '1', graph: {} }])('invalid opt-in recipe %j is rejected by actual config loader', recipe => {
  expect(() => read(recipe)).toThrow();
});
test('a bounded exact pair is preserved and advertised as the available server identity', () => {
  const recipe = { id: 'A'.repeat(80), version: 'v1.0:fixture' }, config = read(recipe);
  expect(config.profiles.quality.recipe).toEqual(recipe);
  expect(describe(config).profiles[0].declaredIdentity).toEqual(recipe);
});
test('a legacy profile remains usable without fabricating any recipe identity', () => {
  const config = read(undefined, false);
  expect(config.profiles.quality.recipe).toBeUndefined(); expect(describe(config).profiles[0].declaredIdentity).toBeUndefined();
});
