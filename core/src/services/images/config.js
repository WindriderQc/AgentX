'use strict';
const fs = require('node:fs');
const net = require('node:net');

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

function loadConfig() {
  if (!process.env.LOCAL_IMAGES_CONFIG) return null;
  const c = JSON.parse(fs.readFileSync(process.env.LOCAL_IMAGES_CONFIG, 'utf8'));
  c.workerUrl = localUrl(c.workerUrl);
  if (!Array.isArray(c.ollamaHosts) || !c.ollamaHosts.length) throw new Error('Image GPU consumers must be configured');
  c.ollamaHosts = [...new Set(c.ollamaHosts.map(localUrl))];
  if (!c.profiles || !c.profiles[c.defaultProfile]) throw new Error('Missing default image profile');
  for (const [id, p] of Object.entries(c.profiles)) {
    if (!/^[a-z0-9-]{1,50}$/.test(id) || !['klein', 'qwen21'].includes(p.family)) throw new Error('Invalid image profile');
    for (const key of ['diffusion', 'encoder', 'vae']) {
      if (!/^[a-zA-Z0-9_.-]+\.safetensors$/.test(p[key] || '')) throw new Error('Invalid image model filename');
    }
    if (!Number.isInteger(p.steps) || p.steps < 1 || p.steps > 50) throw new Error('Invalid image step count');
    if (!Number.isInteger(p.maxPixels) || p.maxPixels < 262144 || p.maxPixels > 4194304) throw new Error('Invalid image pixel budget');
  }
  c.timeoutMs = Math.max(60000, Math.min(1800000, Number(c.timeoutMs) || 900000));
  c.drainMs = Math.max(0, Math.min(90000, Number(c.drainMs) || 60000));
  return c;
}

module.exports = { loadConfig, localUrl };
