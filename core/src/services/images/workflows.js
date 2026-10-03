'use strict';

// Server-owned graphs. Callers select a qualified profile, never arbitrary nodes.
function workflow(profile, { prompt, seed, width, height }, references, id) {
  const graph = {};
  const add = (key, class_type, inputs) => { graph[key] = { class_type, inputs }; return [key, 0]; };
  const model = add('model', 'UNETLoader', { unet_name: profile.diffusion, weight_dtype: profile.weightDtype || 'default' });
  const clip = add('clip', 'CLIPLoader', { clip_name: profile.encoder, type: profile.family === 'klein' ? 'flux2' : 'qwen_image', device: 'default' });
  const vae = add('vae', 'VAELoader', { vae_name: profile.vae });
  let samples;
  if (profile.family === 'qwen21') {
    const inputs = { clip, prompt, negative_prompt: '', resolution: Math.round(Math.sqrt(width * height) / 32) * 32, vae };
    references.forEach((image, i) => { inputs[`image_${i + 1}`] = add(`ref${i}`, 'LoadImage', { image }); });
    add('text', 'TextEncodeQwenImage21', inputs);
    const latent = references.length ? ['text', 2] : add('latent', 'EmptyLatentImage', { width, height, batch_size: 1 });
    const cached = add('cache', 'QwenImage21Cache', { model, device: 'cpu', dtype: 'default' });
    samples = add('sample', 'KSampler', { model: cached, positive: ['text', 0], negative: ['text', 1], latent_image: latent,
      seed, steps: profile.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 });
  } else if (profile.family === 'klein') {
    let positive = add('text', 'CLIPTextEncode', { clip, text: prompt });
    let negative = add('zero', 'ConditioningZeroOut', { conditioning: positive });
    references.forEach((image, i) => {
      const pixels = add(`ref${i}`, 'LoadImage', { image });
      const scaled = add(`scale${i}`, 'ImageScaleToTotalPixels', { image: pixels, upscale_method: 'lanczos', megapixels: width * height / 1e6, resolution_steps: 1 });
      const latent = add(`encode${i}`, 'VAEEncode', { pixels: scaled, vae });
      positive = add(`positive${i}`, 'ReferenceLatent', { conditioning: positive, latent });
      negative = add(`negative${i}`, 'ReferenceLatent', { conditioning: negative, latent });
    });
    const latent_image = add('latent', 'EmptyFlux2LatentImage', { width, height, batch_size: 1 });
    const guider = add('guider', 'CFGGuider', { model, positive, negative, cfg: 1 });
    const sampler = add('sampler', 'KSamplerSelect', { sampler_name: 'euler' });
    const sigmas = add('sigmas', 'Flux2Scheduler', { steps: profile.steps, width, height });
    const noise = add('noise', 'RandomNoise', { noise_seed: seed });
    samples = add('sample', 'SamplerCustomAdvanced', { noise, guider, sampler, sigmas, latent_image });
  } else throw new Error('Unsupported image profile family');
  const images = add('decode', 'VAEDecode', { samples, vae });
  add('save', 'SaveImage', { images, filename_prefix: `agentx/${id}` });
  return graph;
}

module.exports = { workflow };
