const path = require('path');
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

const app = express();
const PORT = process.env.PORT || 3080;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function resolveTarget(target) {
  const fallback = 'http://localhost:11434';
  if (!target || typeof target !== 'string') return fallback;

  const trimmed = target.trim();
  if (!trimmed) return fallback;

  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `http://${trimmed.replace(/\/+$/, '')}`;
}

function buildErrorResponse(err) {
  return {
    status: 'error',
    message: err.message || 'Unknown error',
    details: err.body || undefined,
  };
}

function sanitizeOptions(options = {}) {
  const numericKeys = [
    'temperature',
    'top_k',
    'top_p',
    'num_ctx',
    'repeat_penalty',
    'presence_penalty',
    'frequency_penalty',
    'seed',
    'num_predict',
    'typical_p',
    'tfs_z',
    'mirostat',
    'mirostat_eta',
    'mirostat_tau',
  ];
  const clean = {};

  numericKeys.forEach((key) => {
    if (options[key] === 0 || options[key]) {
      const parsed = Number(options[key]);
      if (!Number.isNaN(parsed)) {
        clean[key] = parsed;
      }
    }
  });

  if (Array.isArray(options.stop)) {
    clean.stop = options.stop;
  } else if (typeof options.stop === 'string' && options.stop.trim()) {
    clean.stop = options.stop
      .split(',')
      .map((val) => val.trim())
      .filter(Boolean);
  }

  if (options.keep_alive) {
    clean.keep_alive = options.keep_alive;
  }

  return clean;
}

async function proxyOllama(pathSegment, target, init) {
  const url = `${resolveTarget(target)}${pathSegment.startsWith('/') ? '' : '/'}${pathSegment}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new Error(`Ollama request failed (${response.status})`);
    error.status = response.status;
    error.body = payload;
    throw error;
  }

  return payload;
}

app.get('/api/ollama/models', async (req, res) => {
  const target = req.query.target || 'localhost:11434';
  try {
    const result = await proxyOllama('/api/tags', target, { method: 'GET' });
    const models = Array.isArray(result?.models)
      ? result.models.map((model) => ({
          name: model.name,
          size: model.size,
          modified_at: model.modified_at,
        }))
      : [];
    res.json({ status: 'success', data: models });
  } catch (err) {
    res.status(err.status || 500).json(buildErrorResponse(err));
  }
});

app.post('/api/ollama/chat', async (req, res) => {
  const { target = 'localhost:11434', model, messages = [], system, options = {} } = req.body || {};

  if (!model) {
    return res.status(400).json({ status: 'error', message: 'Model is required' });
  }

  const formattedMessages = [];
  if (system) {
    formattedMessages.push({ role: 'system', content: system });
  }

  if (Array.isArray(messages)) {
    messages.forEach((msg) => {
      if (msg && msg.role && msg.content) {
        formattedMessages.push({ role: msg.role, content: msg.content });
      }
    });
  }

  if (formattedMessages.length === 0) {
    formattedMessages.push({ role: 'system', content: 'You are AgentX, an efficient local AI assistant.' });
  }

  const payload = {
    model,
    messages: formattedMessages,
    stream: false,
    options: sanitizeOptions(options),
  };

  try {
    const result = await proxyOllama('/api/chat', target, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    res.json({ status: 'success', data: result });
  } catch (err) {
    res.status(err.status || 500).json(buildErrorResponse(err));
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AgentX control running on http://localhost:${PORT}`);
});
