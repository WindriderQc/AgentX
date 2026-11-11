'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { limits, qualified } = require('./sizes');
const { declaredRecipe } = require('./recipeExecution');
const { validateSampling } = require('./qwenTurbo');
const { workersOf, workerFor, candidates, scoped } = require('./workers');
const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;

function localUrl(value) {
  const u = new URL(value);
  const host = u.hostname;
  const local = host === 'localhost' || host === '[::1]' || (net.isIPv4(host) && (
    host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') ||
    (/^172\.(\d+)\./.test(host) && Number(host.split('.')[1]) >= 16 && Number(host.split('.')[1]) <= 31)));
  if (!local || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error('Image worker endpoints must be explicit local/LAN URLs');
  }
  return u.href.replace(/\/$/, '');
}

const ratio = value => {
  if (typeof value !== 'number' || !(value >= 0.3 && value <= 0.95)) throw new Error('Image worker VRAM ratios must be between 0.3 and 0.95');
  return value;
};
function consumers(hosts) {
  if (!Array.isArray(hosts) || !hosts.length) throw new Error('Image GPU consumers must be configured');
  return [...new Set(hosts.map(localUrl))];
}
// One worker per entry, in preference order. A legacy manifest (workerUrl plus
// ollamaHosts) is a single worker that accepts every profile.
function normalizeWorkers(c) {
  if (c.workers !== undefined && (c.workerUrl !== undefined || c.ollamaHosts !== undefined)) {
    throw new Error('Use either workers or workerUrl/ollamaHosts in the image manifest');
  }
  if (c.workers === undefined) {
    c.workerUrl = localUrl(c.workerUrl);
    c.ollamaHosts = consumers(c.ollamaHosts);
    return [{ id: 'default', url: c.workerUrl, ollamaHosts: c.ollamaHosts }];
  }
  if (!Array.isArray(c.workers) || !c.workers.length || c.workers.length > 8) throw new Error('The image manifest needs 1 to 8 workers');
  const ids = new Set(), urls = new Set();
  return c.workers.map(w => {
    if (!w || typeof w !== 'object' || !/^[a-z0-9-]{1,40}$/.test(w.id || '') || ids.has(w.id)) throw new Error('Each image worker needs a unique short id');
    const url = localUrl(w.url);
    if (urls.has(url)) throw new Error('Two image workers share one URL');
    ids.add(w.id); urls.add(url);
    if (w.profiles !== undefined && (!Array.isArray(w.profiles) || !w.profiles.length || w.profiles.some(id => !c.profiles[id]))) {
      throw new Error('An image worker names an unknown profile');
    }
    if (w.presentation !== undefined && (!w.presentation || typeof w.presentation !== 'object' || Array.isArray(w.presentation))) {
      throw new Error('Invalid image worker presentation');
    }
    return { id: w.id, url, ollamaHosts: consumers(w.ollamaHosts),
      ...(w.profiles && { profiles: [...new Set(w.profiles)] }),
      ...(w.minFreeVramRatio !== undefined && { minFreeVramRatio: ratio(w.minFreeVramRatio) }),
      ...(w.releasedVramRatio !== undefined && { releasedVramRatio: ratio(w.releasedVramRatio) }),
      ...(w.presentation && { presentation: w.presentation }),
      ...(w.keepResidents !== undefined && { keepResidents: keptResidents(w.keepResidents) }) };
  });
}
// Ollama models an immediate image may leave loaded on its worker, such as a
// small pinned embedding model. Any other resident still refuses the attempt.
function keptResidents(value) {
  if (!Array.isArray(value) || value.length > 8 || value.some(name => typeof name !== 'string' || !MODEL_NAME.test(name))) {
    throw new Error('keepResidents must list at most 8 Ollama model names');
  }
  return [...new Set(value)];
}
// Family's illustrated mode: one named worker, one quick profile, one size.
// Absent means the mode is off.
function illustrated(c) {
  const v = c.illustrated;
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid illustrated image settings');
  const worker = c.workers.find(w => w.id === v.worker);
  if (!worker) throw new Error('The illustrated mode names an unknown image worker');
  const profile = c.profiles[v.profile];
  if (!profile || profile.family !== 'klein' || (worker.profiles && !worker.profiles.includes(v.profile))) {
    throw new Error('The illustrated mode needs a quick profile its worker accepts');
  }
  const width = v.width === undefined ? 768 : v.width, height = v.height === undefined ? width : v.height;
  if (!qualified(profile, width, height)) throw new Error('The illustrated image size is not qualified for its profile');
  const intervalSeconds = v.intervalSeconds === undefined ? 60 : v.intervalSeconds;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) throw new Error('The illustrated interval must be 30 to 3600 seconds');
  return { worker: worker.id, profile: v.profile, width, height, intervalSeconds };
}

function loadConfig() {
  if (!process.env.LOCAL_IMAGES_CONFIG) return null;
  const c = JSON.parse(fs.readFileSync(process.env.LOCAL_IMAGES_CONFIG, 'utf8'));
  if (!c.profiles || !c.profiles[c.defaultProfile]) throw new Error('Missing default image profile');
  for (const [id, p] of Object.entries(c.profiles)) {
    if (!/^[a-z0-9-]{1,50}$/.test(id) || !['klein', 'qwen21'].includes(p.family)) throw new Error('Invalid image profile');
    for (const key of ['diffusion', 'encoder', 'vae']) {
      if (!/^[a-zA-Z0-9_.-]+\.safetensors$/.test(p[key] || '')) throw new Error('Invalid image model filename');
    }
    if (!Number.isInteger(p.steps) || p.steps < 1 || p.steps > 50) throw new Error('Invalid image step count');
    validateSampling(p);
    if (!Number.isInteger(p.maxPixels) || p.maxPixels < 262144 || p.maxPixels > limits(p.family).maxPixels) throw new Error('Invalid image pixel budget');
    if (p.recipe !== undefined) p.recipe = declaredRecipe(p.recipe);
  }
  c.workers = normalizeWorkers(c);
  c.illustrated = illustrated(c);
  if (c.illustrated === undefined) delete c.illustrated;
  for (const id of Object.keys(c.profiles)) {
    if (!candidates(c, id).length) throw new Error('An image profile has no worker');
  }
  c.timeoutMs = Math.max(60000, Math.min(1800000, Number(c.timeoutMs) || 900000));
  c.drainMs = Math.max(0, Math.min(90000, Number(c.drainMs) || 60000));
  return c;
}

module.exports = { loadConfig, localUrl, workersOf, workerFor, candidates, scoped };
