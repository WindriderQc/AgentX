'use strict';
const fetch = require('node-fetch');
const { decode } = require('./codec');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createComfyClient(base, fetchImpl = fetch) {
  async function json(route, body, method = body === undefined ? 'GET' : 'POST') {
    const r = await fetchImpl(`${base}${route}`, { method, timeout: 15000, redirect: 'error',
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!r.ok) throw Object.assign(new Error(`Image worker HTTP ${r.status}`), { status: r.status });
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  }
  async function ready(profile) {
    const [stats, queue, nodes] = await Promise.all([json('/system_stats'), json('/queue'), json('/object_info')]);
    if (queue.queue_running?.length || queue.queue_pending?.length) throw new Error('Image worker is already busy');
    for (const [node, input, value] of [
      ['UNETLoader', 'unet_name', profile.diffusion], ['CLIPLoader', 'clip_name', profile.encoder], ['VAELoader', 'vae_name', profile.vae]
    ]) {
      if (!nodes[node]?.input?.required?.[input]?.[0]?.includes(value)) throw new Error('Image model is not installed');
    }
    return stats;
  }
  async function upload(bytes, name) {
    const boundary = `agentx-${require('node:crypto').randomUUID()}`;
    const data = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--${boundary}--\r\n`)]);
    const r = await fetchImpl(`${base}/upload/image`, { method: 'POST', timeout: 30000,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: data });
    if (!r.ok) throw new Error('Image reference upload failed');
    const result = await r.json();
    if (result.name !== name || result.subfolder) throw new Error('Image worker returned an unexpected upload path');
    return result.name;
  }
  async function submit(id, prompt) {
    // No retry: ComfyUI does not deduplicate a client-supplied prompt_id.
    let r;
    try { r = await json('/prompt', { prompt_id: id, client_id: id, prompt }); }
    catch (error) { if (error.status === 400) error.notSubmitted = true; throw error; }
    if (r.prompt_id !== id) throw new Error('Image worker did not retain the operation identity');
    return r;
  }
  async function observe(id, { timeoutMs, cancelled, assertOwned, onTerminal }) {
    const end = Date.now() + timeoutMs;
    let cancelSent = false;
    while (Date.now() < end + 60000) {
      await assertOwned();
      if (!cancelSent && (await cancelled() || Date.now() >= end)) {
        await json(`/api/jobs/${id}/cancel`, {}); cancelSent = true;
      }
      const history = await json(`/history/${id}`);
      const item = history[id];
      if (item?.status && ['success', 'error'].includes(item.status.status_str)) {
        await onTerminal();
        const output = item.outputs?.save?.images?.[0];
        if (item.status.status_str !== 'success' || !item.status.completed || !output) {
          throw Object.assign(new Error(cancelSent ? 'Image generation cancelled' : 'Image generation failed'), { terminal: true, cancelled: cancelSent });
        }
        if (output.type !== 'output' || !/^[a-zA-Z0-9_.-]+\.png$/.test(output.filename) || output.subfolder !== 'agentx') throw Object.assign(new Error('Unexpected image output path'), { terminal: true });
        return output;
      }
      await sleep(1000);
    }
    throw new Error('Image worker outcome is unknown; recovery is required');
  }
  async function read(output) {
    if (output?.type !== 'output' || output.subfolder !== 'agentx' || !/^[a-zA-Z0-9_.-]+\.png$/.test(output.filename || '')) throw new Error('Unexpected image output path');
    const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: 'output' });
    const r = await fetchImpl(`${base}/view?${query}`, { timeout: 30000, size: 50 * 1024 * 1024 });
    if (!r.ok) throw new Error('Image output is unavailable');
    const bytes = await r.buffer(); decode(bytes, 4194304); return bytes;
  }
  async function free(assertOwned, requireEmptyGpu = true) {
    await assertOwned();
    const q = await json('/queue');
    if (q.queue_running?.length || q.queue_pending?.length) throw new Error('Worker has unfinished work');
    await json('/free', { unload_models: true, free_memory: true });
    for (let i = 0; i < 30; i++) {
      await assertOwned();
      const stats = await json('/system_stats');
      const device = stats.devices?.[0];
      if (device && device.torch_vram_total - device.torch_vram_free < 256 * 1024 * 1024
        && (!requireEmptyGpu || device.vram_free > device.vram_total * 0.85)) return stats;
      await sleep(1000);
    }
    throw new Error('Image worker memory release is unverified');
  }
  return { json, ready, upload, submit, observe, read, free };
}
module.exports = { createComfyClient };
