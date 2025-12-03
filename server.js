require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3080;

// In-memory stores to keep basic chat logs and user profile
const sessions = new Map();
let profile = {
  language: 'English',
  role: 'General assistant',
  style: 'Concise and clear',
};
// Connect to Database
connectDB();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// V3: Mount RAG routes
const ragRoutes = require('./routes/rag');
app.use('/api/rag', ragRoutes);

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

function getSession(threadId = 'default') {
  if (!sessions.has(threadId)) {
    sessions.set(threadId, {
      id: threadId,
      createdAt: new Date().toISOString(),
      messages: [],
      system: null,
      feedback: [],
    });
  }
  return sessions.get(threadId);
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

app.post('/api/chat', async (req, res) => {
  const {
    target = 'localhost:11434',
    model,
    message,
    threadId = 'default',
    system,
    options = {},
    stream = false,
    profile: incomingProfile,
  } = req.body || {};

  if (!model) {
    return res.status(400).json({ status: 'error', message: 'Model is required' });
  }

  if (!message || !message.trim()) {
    return res.status(400).json({ status: 'error', message: 'Message content is required' });
  }

  if (incomingProfile && typeof incomingProfile === 'object') {
    profile = { ...profile, ...incomingProfile };
  }

  const session = getSession(threadId);
  if (system) {
    session.system = system;
  }

  const messageId = Date.now();
  const userMessage = { id: `u-${messageId}`, role: 'user', content: message, createdAt: new Date().toISOString() };
  session.messages.push(userMessage);

  const formattedMessages = [];
  if (session.system) {
    formattedMessages.push({ role: 'system', content: session.system });
  }

  session.messages.forEach((msg) => {
    formattedMessages.push({ role: msg.role, content: msg.content });
  });

  const payload = {
    model,
    messages: formattedMessages,
    stream,
    options: sanitizeOptions(options),
  };

  try {
    const result = await proxyOllama('/api/chat', target, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const responseText =
      result?.message?.content || result?.response || result?.output || 'No response from Ollama.';

    const assistantMessage = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: responseText,
      createdAt: new Date().toISOString(),
      usage: result?.eval_count || result?.completion_tokens,
    };

    session.messages.push(assistantMessage);

    res.json({
      status: 'success',
      data: {
        threadId: session.id,
        message: assistantMessage,
        history: session.messages,
        profile,
      },
    });
  } catch (err) {
    // roll back the last user message if the call failed
    session.messages = session.messages.filter((m) => m.id !== userMessage.id);
    res.status(err.status || 500).json(buildErrorResponse(err));
  }
});

app.get('/api/logs', (req, res) => {
  const { threadId } = req.query;
  if (threadId) {
    const session = sessions.get(threadId);
    if (!session) {
      return res.status(404).json({ status: 'error', message: 'Session not found' });
    }
    return res.json({ status: 'success', data: session });
  }
  res.json({ status: 'success', data: Array.from(sessions.values()) });
});

app.get('/api/profile', (_req, res) => {
  res.json({ status: 'success', data: profile });
});

app.put('/api/profile', (req, res) => {
  const { language, role, style } = req.body || {};
  profile = {
    language: language || profile.language,
    role: role || profile.role,
    style: style || profile.style,
  };
  res.json({ status: 'success', data: profile });
});

app.post('/api/feedback', (req, res) => {
  const { threadId = 'default', messageId, rating, comment } = req.body || {};
  if (!messageId || typeof rating === 'undefined') {
    return res.status(400).json({ status: 'error', message: 'messageId and rating are required' });
  }

  const session = getSession(threadId);
  session.feedback.push({
    id: `f-${Date.now()}`,
    messageId,
    rating,
    comment: comment || null,
    createdAt: new Date().toISOString(),
  });

  res.json({ status: 'success', data: { threadId, messageId, rating } });
});

// Routes
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes);

// Health Check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT });
});

// Fallback to Frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AgentX control running on http://localhost:${PORT}`);
});
