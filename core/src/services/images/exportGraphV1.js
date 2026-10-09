'use strict';
// Frozen verification contract for stored builder v1. Never rebuild an export
// with the current workflow/profile: the original graph bytes remain the part.
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const fail = () => Object.assign(new Error('Le graphe enregistré est incohérent ou non exportable.'), { statusCode: 503 });
const requireValid = value => { if (!value) throw fail(); };
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keys = (value, expected) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateGraph(op, referenceCount) {
  const { execution: e, request: r, profile: p } = op;
  requireValid(object(e) && e.version === 1 && keys(e.builder, ['id', 'version'])
    && e.builder.id === 'agentx.local-images.workflows' && e.builder.version === 1);
  requireValid(object(r) && typeof r.prompt === 'string' && r.prompt.trim() && r.prompt.length <= 8000
    && Number.isSafeInteger(r.seed) && r.seed >= 0 && object(p) && ['klein', 'qwen21'].includes(p.family));
  const maxEdge = p.family === 'klein' ? 2048 : 2752, maxPixels = p.family === 'klein' ? 4194304 : 4300800;
  requireValid([r.width, r.height].every(n => Number.isInteger(n) && n >= 256 && n <= maxEdge && n % 32 === 0)
    && r.width * r.height <= maxPixels && Number.isInteger(p.steps) && p.steps >= 1 && p.steps <= 50);
  requireValid(keys(e.parameters, ['width', 'height', 'seed', 'steps'])
    && isDeepStrictEqual(e.parameters, { width: r.width, height: r.height, seed: r.seed, steps: p.steps }));
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
  const clip = check('clip', 'CLIPLoader', { clip_name: p.encoder, type: p.family === 'klein' ? 'flux2' : 'qwen_image', device: 'default' });
  const vae = check('vae', 'VAELoader', { vae_name: p.vae });
  const reference = i => check(`ref${i}`, 'LoadImage', { image: `agentx-${op._id}-${i}.png` });
  let samples;
  if (p.family === 'qwen21') {
    const resolution = Math.round(Math.sqrt(r.width * r.height) / 32) * 32;
    const inputs = { clip, prompt: r.prompt, negative_prompt: '', resolution: referenceCount ? resolution - 32 : resolution, vae };
    for (let i = 0; i < referenceCount; i++) inputs[`images.image_${i + 1}`] = reference(i);
    check('text', 'TextEncodeQwenImage21', inputs);
    const latent = referenceCount ? ['text', 2] : check('latent', 'EmptyLatentImage', { width: r.width, height: r.height, batch_size: 1 });
    const cached = check('cache', 'QwenImage21Cache', { model, device: 'cpu', dtype: 'default' });
    samples = check('sample', 'KSampler', { model: cached, positive: ['text', 0], negative: ['text', 1], latent_image: latent,
      seed: r.seed, steps: p.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 });
  } else {
    let positive = check('text', 'CLIPTextEncode', { clip, text: r.prompt });
    let negative = check('zero', 'ConditioningZeroOut', { conditioning: positive });
    for (let i = 0; i < referenceCount; i++) {
      const pixels = reference(i);
      const scaled = check(`scale${i}`, 'ImageScaleToTotalPixels', { image: pixels, upscale_method: 'lanczos', megapixels: r.width * r.height / 1048576, resolution_steps: 32 });
      const latent = check(`encode${i}`, 'VAEEncode', { pixels: scaled, vae });
      positive = check(`positive${i}`, 'ReferenceLatent', { conditioning: positive, latent });
      negative = check(`negative${i}`, 'ReferenceLatent', { conditioning: negative, latent });
    }
    const latent_image = check('latent', 'EmptyFlux2LatentImage', { width: r.width, height: r.height, batch_size: 1 });
    const guider = check('guider', 'CFGGuider', { model, positive, negative, cfg: 1 });
    const sampler = check('sampler', 'KSamplerSelect', { sampler_name: 'euler' });
    const sigmas = check('sigmas', 'Flux2Scheduler', { steps: p.steps, width: r.width, height: r.height });
    const noise = check('noise', 'RandomNoise', { noise_seed: r.seed });
    samples = check('sample', 'SamplerCustomAdvanced', { noise, guider, sampler, sigmas, latent_image });
  }
  const images = check('decode', 'VAEDecode', { samples, vae });
  check('save', 'SaveImage', { images, filename_prefix: `agentx/${op._id}` });
  requireValid(keys(e.graph, seen));
  return bytes;
}
module.exports = { validateGraph, object, uuid, digest, sha };
