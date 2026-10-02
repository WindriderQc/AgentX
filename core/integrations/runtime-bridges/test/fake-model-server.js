'use strict';

const http = require('http');

const port = Number(process.env.PORT || 0);
const model = process.env.TEST_MODEL || 'model-a';
const stats = { requests: 0, streams: 0, completedStreams: 0, cancelledStreams: 0 };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  stats.requests += 1;
  if (req.url === '/test/stats') return json(res, 200, stats);
  if (req.method === 'GET' && req.url === '/api/tags') {
    return json(res, 200, { models: [{ name: model, model }] });
  }
  if (req.method === 'GET' && req.url === '/api/ps') {
    return json(res, 200, { models: [{ name: model, model, expires_at: '9999-12-31T23:59:59Z' }] });
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'not found' });

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 400, { error: 'invalid json' }); }

  if (req.url === '/api/show') {
    if (body.name !== model && body.model !== model) return json(res, 404, { error: 'model not found' });
    return json(res, 200, {
      parameters: 'num_ctx 32768',
      model_info: { 'test.context_length': 32768 },
      capabilities: ['completion', 'tools']
    });
  }
  if (req.url === '/api/embed') {
    return json(res, 200, { model, embeddings: [[0.1, 0.2, 0.3]], total_duration: 1 });
  }
  if (!['/api/chat', '/api/generate'].includes(req.url)) return json(res, 404, { error: 'unsupported' });

  const input = JSON.stringify(body.messages || body.prompt || '');
  if (input.includes('[upstream-error]')) return json(res, 500, { error: 'synthetic upstream failure' });
  if (input.includes('[timeout]')) return undefined;
  if (body.stream === true) {
    stats.streams += 1;
    let finished = false;
    let index = 0;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      index += 1;
      res.write(JSON.stringify({
        model,
        message: { role: 'assistant', content: index === 1 ? 'first-token' : `-${index}` },
        done: index >= 20,
        ...(index >= 20 && { prompt_eval_count: 3, eval_count: 20 })
      }) + '\n');
      if (index >= 20) {
        finished = true;
        clearInterval(timer);
        stats.completedStreams += 1;
        res.end();
      }
    }, 50);
    res.once('close', () => {
      clearInterval(timer);
      if (!finished) stats.cancelledStreams += 1;
    });
    return undefined;
  }
  if (req.url === '/api/chat') {
    return json(res, 200, {
      model,
      message: { role: 'assistant', content: 'synthetic response' },
      done: true,
      prompt_eval_count: 3,
      eval_count: 2
    });
  }
  return json(res, 200, { model, response: 'synthetic response', done: true, prompt_eval_count: 3, eval_count: 2 });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake model server listening on ${server.address().port}\n`);
});
