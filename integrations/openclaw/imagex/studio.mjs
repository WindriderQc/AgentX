import { spawn } from 'node:child_process';
import path from 'node:path';
import { prepareImage } from './expert.mjs';

export function invokeStudio(command, input, { emit = () => {}, signal, timeoutMs = 165000, spawnImpl = spawn } = {}) {
  if (!path.isAbsolute(command || '')) throw new Error('Image expert executable unavailable');
  if (!['describe', 'resource', 'consult', 'plan'].includes(input?.action)) throw new Error('Invalid image expert action');
  if (JSON.stringify(input).length > 60000) throw new Error('Image expert request too large');
  if (signal?.aborted) throw new Error('Image expert interrupted');
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, ['--events'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let pending = '', bytes = 0, result, stopped, killTimer, settled = false;
    const stop = reason => {
      if (stopped || settled) return;
      stopped = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 6000);
      killTimer.unref?.();
    };
    const abort = () => stop('Image expert interrupted');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Hermes a dépassé le délai de consultation.'), timeoutMs);
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    child.on('error', () => finish(new Error('Image expert could not start')));
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});
    const consume = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'result') {
        if (result) throw new Error('Duplicate expert result');
        result = event.result;
      } else if (['started', 'tool_use', 'tool_result'].includes(event.type)) emit(event);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      if (stopped) return;
      bytes += Buffer.byteLength(data); pending += data;
      if (bytes > 262144) return stop('Image expert response exceeded its limit');
      try {
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) consume(line);
      } catch { stop('Image expert returned an invalid event'); }
    });
    child.on('close', code => {
      try {
        if (pending && !stopped) consume(pending);
        if (stopped) throw new Error(stopped);
        if (code !== 0 || result?.ok !== true || result.expert !== 'hermes') {
          throw new Error(result?.error || 'Hermes n’a pas terminé cette consultation.');
        }
        if (['consult', 'plan'].includes(input.action) && (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 16000)) {
          throw new Error('Hermes returned no bounded final reply');
        }
        if (input.action === 'plan') result.proposal = prepareImage(input.request, input.status, result).expert.plan;
        finish();
      } catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function registerStudioRoute(api, { invoke = invokeStudio } = {}) {
  api.registerHttpRoute({ path: '/api/agentx/imagex/studio', auth: 'gateway', match: 'exact', handler: async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) throw new Error('Image expert request too large');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      const emit = event => { if (!controller.signal.aborted) res.write(JSON.stringify(event) + '\n'); };
      const result = await invoke(api.pluginConfig?.workerCommand, input, { emit, signal: controller.signal });
      if (!controller.signal.aborted) res.end(JSON.stringify({ type: 'result', result }) + '\n');
    } catch (error) {
      if (!controller.signal.aborted) {
        if (!res.headersSent) res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.end(JSON.stringify({ type: 'error', message: String(error.message).slice(0, 240) }) + '\n');
      }
    } finally { res.removeListener('close', abort); }
  } });
}
