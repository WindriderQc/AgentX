'use strict';
// Frozen Turbo builder v2 contract. Verify archived bytes without invoking the
// current builder or inheriting a future checkpoint's sampling schedule.
const { isDeepStrictEqual } = require('node:util');
const { object, digest, sha } = require('./exportGraphV1');
const fail = () => Object.assign(new Error('Le graphe enregistré est incohérent ou non exportable.'), { statusCode: 503 });
const requireValid = value => { if (!value) throw fail(); };
const keys = (value, expected) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
const SIGMAS = '1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0';

function validateGraph(op, referenceCount) {
  const { execution: e, request: r, profile: p } = op;
  requireValid(object(e) && e.version === 1 && keys(e.builder, ['id', 'version'])
    && e.builder.id === 'agentx.local-images.workflows' && e.builder.version === 2);
  requireValid(object(r) && typeof r.prompt === 'string' && r.prompt.trim() && r.prompt.length <= 8000
    && Number.isSafeInteger(r.seed) && r.seed >= 0 && object(p)
    && p.family === 'qwen21' && p.sampling === 'qwen21-turbo' && p.steps === 8);
  requireValid(Number.isInteger(referenceCount) && referenceCount >= 0 && referenceCount <= 2);
  requireValid([r.width, r.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2752 && n % 32 === 0)
    && r.width * r.height <= 4300800);
  requireValid(keys(e.parameters, ['width', 'height', 'seed', 'steps'])
    && isDeepStrictEqual(e.parameters, { width: r.width, height: r.height, seed: r.seed, steps: 8 }));
  for (const field of ['diffusion', 'encoder', 'vae']) requireValid(typeof p[field] === 'string'
    && /^[a-zA-Z0-9_.-]+\.safetensors$/.test(p[field]));
  const dtype = p.weightDtype || 'default';
  requireValid(typeof dtype === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(dtype));
  requireValid(object(e.graph) && digest(e.graphSha256));
  let bytes;
  try { bytes = Buffer.from(JSON.stringify(e.graph)); } catch { throw fail(); }
  requireValid(bytes.length <= 65536 && sha(bytes) === e.graphSha256);
  const seen = [];
  const check = (name, type, inputs) => {
    const node = e.graph[name];
    requireValid(keys(node, ['class_type', 'inputs']) && node.class_type === type && isDeepStrictEqual(node.inputs, inputs));
    seen.push(name); return [name, 0];
  };
  const model = check('model', 'UNETLoader', { unet_name: p.diffusion, weight_dtype: dtype });
  const clip = check('clip', 'CLIPLoader', { clip_name: p.encoder, type: 'qwen_image', device: 'default' });
  const vae = check('vae', 'VAELoader', { vae_name: p.vae });
  const resolution = Math.round(Math.sqrt(r.width * r.height) / 32) * 32;
  const inputs = { clip, prompt: r.prompt, negative_prompt: '', resolution: referenceCount ? resolution - 32 : resolution, vae };
  for (let i = 0; i < referenceCount; i++) {
    inputs[`images.image_${i + 1}`] = check(`ref${i}`, 'LoadImage', { image: `agentx-${op._id}-${i}.png` });
  }
  check('text', 'TextEncodeQwenImage21', inputs);
  const latent = referenceCount ? ['text', 2] : check('latent', 'EmptyLatentImage', { width: r.width, height: r.height, batch_size: 1 });
  const cached = check('cache', 'QwenImage21Cache', { model, device: 'cpu', dtype: 'default' });
  const guider = check('guider', 'CFGGuider', { model: cached, positive: ['text', 0], negative: ['text', 1], cfg: 1 });
  const sampler = check('sampler', 'KSamplerSelect', { sampler_name: 'euler' });
  const sigmas = check('sigmas', 'ManualSigmas', { sigmas: SIGMAS });
  const noise = check('noise', 'RandomNoise', { noise_seed: r.seed });
  const samples = check('sample', 'SamplerCustomAdvanced', { noise, guider, sampler, sigmas, latent_image: latent });
  const images = check('decode', 'VAEDecode', { samples, vae });
  check('save', 'SaveImage', { images, filename_prefix: `agentx/${op._id}` });
  requireValid(keys(e.graph, seen));
  return bytes;
}
module.exports = { validateGraph };
