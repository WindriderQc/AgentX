'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createAuth } = require('./auth');
const { createVoiceClient } = require('./voice');
const { createReviewer } = require('./reviewer');
const { cleanText, stateForPrompt } = require('../../../src/domains/psyx/stateRepository');
const domain = require('../../../src/domains/psyx/domain');
const { detectRecentCrisis } = require('../../../src/domains/psyx/safety');

const VERSION = '2.7.0';
const PROMPT_VERSION = domain.PROMPT_VERSION;
const PUBLIC_ROOT = path.join(__dirname, '..', 'public');
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function responseData(res, data, status = 200) {
  return res.status(status).json({ ok: true, status: 'success', data });
}

function providerHandlers(res) {
  let content = '';
  let route = null;
  let thinking = false;
  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return {
    onToken(delta) {
      if (!delta) return;
      content += delta;
      send('token', { content: delta });
    },
    onThinking(delta) {
      thinking = true;
      send('thinking', { content: delta || '' });
    },
    onRoute(value) {
      route = value;
      send('route', value);
    },
    content: () => content,
    route: () => route,
    thinkingObserved: () => thinking,
    send
  };
}

function serviceStatus(config, accessConfigured = false, frontierSupported = false) {
  return {
    extension: 'psyx',
    extensionVersion: VERSION,
    serviceVersion: VERSION,
    persona: { name: 'psyx', version: PROMPT_VERSION, installed: true, active: true, competingActiveVersions: 0 },
    chatEndpoint: '/api/psyx/chat/stream',
    historyEndpoint: '/api/psyx/sessions',
    ui: '/psyx',
    modes: domain.MODE_CONFIG,
    depths: domain.DEPTH_CONFIG,
    routing: {
      provider: config.provider,
      normalTaskType: domain.DEPTH_CONFIG.normal.taskType,
      deepTaskType: domain.DEPTH_CONFIG.deep.taskType,
      configEndpoint: '/api/psyx/routing'
    },
    frontier: frontierSupported
      ? { supported: true, enabled: true, location: 'frontier', model: config.frontier.model, defaultMode: config.frontier.defaultMode, modes: domain.FRONTIER_MODES }
      : { supported: false, enabled: false, location: 'local' },
    stateVersion: 2,
    privacy: {
      protected: config.accessMode !== 'trusted-network',
      configured: config.accessMode === 'trusted-network' || Boolean(config.accessToken) || accessConfigured,
      accessMode: config.accessMode,
      sessionHours: config.sessionTtlMs / 3600000
    },
    conversationLifecycle: {
      provider: 'agentx-core',
      contractVersion: 1,
      archive: true,
      restore: true,
      permanentDelete: true,
      transcriptExport: true,
      sessionDigest: config.review?.enabled !== false
    },
    review: {
      automatic: config.review?.enabled !== false,
      taskType: config.review?.taskType || 'deep_reasoning',
      statusEndpoint: '/api/psyx/review/status'
    },
    voice: {
      enabled: config.voice?.mode === 'voix',
      provider: config.voice?.mode === 'voix' ? 'voix' : null,
      statusEndpoint: '/api/psyx/voice/status',
      synthesizeEndpoint: '/api/psyx/voice/synthesize',
      // Engine, language and voice travel with each synthesis request from this
      // browser; PsyX never writes the shared VoiX service configuration.
      requestScopedPreferences: true,
      ttsProviders: ['kokoro', 'windows_sapi'],
      secureContextRequired: true,
      storesAudio: false
    }
  };
}

function exportDocument({ state, metadata, conversations }) {
  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    psyx: { serviceVersion: VERSION, promptVersion: PROMPT_VERSION, stateVersion: 2 },
    longitudinalState: state,
    sessionMetadata: metadata,
    transcriptData: { included: true, owner: 'AgentX Core', conversationCount: conversations.length, conversations }
  };
}

function createApp({ config, database, provider, voice = null, logger = console, accessAuth = null, reviewer = null }) {
  if (!config || !database || !provider) throw new Error('config, database, and provider are required');
  const app = express();
  const auth = accessAuth || createAuth(config);
  const voiceClient = voice || createVoiceClient(config);
  const { stateRepository, conversationRepository } = database;
  const streaming = new Map();
  const frontierSupported = () => Boolean(provider.frontierReady?.());
  // The user's choice, else the instance default; always local when no frontier agent is configured.
  const frontierMode = state => frontierSupported() ? state.settings?.frontierMode || config.frontier?.defaultMode || 'local' : 'local';
  const review = reviewer || createReviewer({ config, provider, stateRepository, conversationRepository, logger,
    isBusy: userId => (streaming.get(userId) || 0) > 0,
    locationFor: state => frontierMode(state) === 'local' ? 'local' : 'frontier' });

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  app.use(cookieParser());
  app.use(express.json({ limit: config.maxBodyBytes }));

  app.get('/healthz', (_req, res) => responseData(res, { status: 'alive', service: 'psyx', version: VERSION }));
  app.get('/readyz', asyncRoute(async (_req, res) => {
    const checks = { database: { ok: false }, provider: { ok: false, id: provider.id } };
    await Promise.all([
      database.ping().then(() => { checks.database.ok = true; }).catch((error) => {
        checks.database.code = 'unavailable';
        logger.error?.('PsyX readiness database check failed', { message: error.message });
      }),
      provider.probe().then(() => { checks.provider.ok = true; }).catch((error) => {
        checks.provider.code = 'unavailable';
        logger.error?.('PsyX readiness provider check failed', { provider: provider.id, message: error.message });
      })
    ]);
    const ready = checks.database.ok && checks.provider.ok;
    res.status(ready ? 200 : 503).json({ ok: ready, status: ready ? 'ready' : 'not_ready', data: { checks } });
  }));

  app.get('/', (_req, res) => res.redirect('/psyx'));
  app.get('/psyx/assets/voice-audio.js', asyncRoute(async (_req, res) => {
    res.type('application/javascript').set('Cache-Control', 'public, max-age=300')
      .send(config.voice?.mode === 'voix' ? await voiceClient.player() : '// Local voice is disabled for this instance.');
  }));
  app.use('/psyx/assets', express.static(PUBLIC_ROOT, { index: false, fallthrough: false, maxAge: config.env === 'production' ? '1h' : 0 }));
  // Serve relative to the public root so a dot-segment in the checkout path is never treated as a dotfile.
  app.get('/psyx', (_req, res) => res.sendFile('index.html', { root: PUBLIC_ROOT }));

  const api = express.Router();
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.get('/auth/status', (req, res) => responseData(res, {
    unlocked: Boolean(auth.current(req)),
    configured: config.accessMode === 'trusted-network' || Boolean(config.accessToken) || Boolean(auth.configured?.(req)),
    accessMode: config.accessMode,
    loopback: auth.isLoopback(req),
    sessionHours: config.sessionTtlMs / 3600000
  }));
  api.post('/auth/unlock', (req, res) => {
    const result = auth.unlock(req, res, req.body?.code);
    if (!result.ok) return res.status(result.status).json({ ok: false, status: 'error', code: result.code, message: result.message });
    return responseData(res, { unlocked: true, sessionHours: config.sessionTtlMs / 3600000 });
  });
  api.post('/auth/lock', (req, res) => {
    auth.lock(req, res);
    return responseData(res, { unlocked: Boolean(auth.current(req)) });
  });
  api.use(auth.requireSession);

  api.get('/status', (req, res) => responseData(res, serviceStatus(config, Boolean(auth.configured?.(req)), frontierSupported())));
  api.post('/bootstrap', (req, res) => responseData(res, serviceStatus(config, Boolean(auth.configured?.(req)), frontierSupported())));
  api.post('/state/settings', asyncRoute(async (req, res) => responseData(res, await stateRepository.updateSettings(res.locals.psyxUserId, { frontierMode: req.body?.frontierMode }))));
  api.get('/state', asyncRoute(async (_req, res) => responseData(res, await stateRepository.read(res.locals.psyxUserId))));
  api.get('/state/prompt-context', asyncRoute(async (_req, res) => responseData(res, stateForPrompt(await stateRepository.read(res.locals.psyxUserId)))));
  api.post('/state/items/:key', asyncRoute(async (req, res) => responseData(res, await stateRepository.addItem(res.locals.psyxUserId, req.params.key, req.body || {}))));
  api.patch('/state/items/:key/:id', asyncRoute(async (req, res) => responseData(res, await stateRepository.updateItem(res.locals.psyxUserId, req.params.key, cleanText(req.params.id, 80), req.body || {}))));
  api.delete('/state/items/:key/:id', asyncRoute(async (req, res) => responseData(res, await stateRepository.deleteItem(res.locals.psyxUserId, req.params.key, cleanText(req.params.id, 80)))));
  api.post('/state/experiments', asyncRoute(async (req, res) => responseData(res, await stateRepository.addExperiment(res.locals.psyxUserId, req.body || {}))));
  api.patch('/state/experiments/:id', asyncRoute(async (req, res) => responseData(res, await stateRepository.updateExperiment(res.locals.psyxUserId, cleanText(req.params.id, 80), req.body || {}))));
  api.post('/state/check-ins', asyncRoute(async (req, res) => responseData(res, await stateRepository.addCheckIn(res.locals.psyxUserId, {
    score: req.body?.score, phase: req.body?.phase
  }))));
  api.post('/state/proposals/:id/accept', asyncRoute(async (req, res) => responseData(res, await stateRepository.acceptProposal(res.locals.psyxUserId, cleanText(req.params.id, 80), req.body || {}))));
  api.post('/state/proposals/:id/reject', asyncRoute(async (req, res) => responseData(res, await stateRepository.rejectProposal(res.locals.psyxUserId, cleanText(req.params.id, 80)))));
  api.get('/review/status', (req, res) => responseData(res, review.status(res.locals.psyxUserId, cleanText(req.query.conversationId, 80))));
  api.post('/state/reset', asyncRoute(async (req, res) => {
    if (req.body?.confirmation !== 'RESET PSYX MEMORY') return res.status(400).json({ ok: false, status: 'error', code: 'PSYX_RESET_CONFIRMATION_REQUIRED', message: 'Type RESET PSYX MEMORY to confirm.' });
    return responseData(res, await stateRepository.reset(res.locals.psyxUserId));
  }));
  api.get('/export', asyncRoute(async (_req, res) => {
    const userId = res.locals.psyxUserId;
    const [state, metadata, conversations] = await Promise.all([
      stateRepository.read(userId),
      conversationRepository.listSessionMetadata(userId),
      conversationRepository.listTranscripts(userId)
    ]);
    const document = exportDocument({ state, metadata, conversations });
    res.setHeader('Content-Disposition', `attachment; filename="psyx-export-${document.exportedAt.slice(0, 10)}.json"`);
    return res.json(document);
  }));
  api.get('/sessions', asyncRoute(async (req, res) => responseData(res, await conversationRepository.listSessions(res.locals.psyxUserId, req.query.limit, req.query.status || 'active'))));
  api.get('/sessions/:id', asyncRoute(async (req, res) => {
    const session = await conversationRepository.getSession(res.locals.psyxUserId, req.params.id);
    return session ? responseData(res, session) : res.status(404).json({ ok: false, status: 'error', message: 'PsyX session not found' });
  }));
  api.patch('/sessions/:id', asyncRoute(async (req, res) => {
    const session = await conversationRepository.rename(res.locals.psyxUserId, req.params.id, req.body?.title);
    return session ? responseData(res, session) : res.status(404).json({ ok: false, status: 'error', message: 'PsyX session not found' });
  }));
  api.post('/sessions/:id/archive', asyncRoute(async (req, res) => {
    const session = await conversationRepository.archive(res.locals.psyxUserId, req.params.id);
    return session ? responseData(res, session) : res.status(404).json({ ok: false, status: 'error', message: 'Active PsyX session not found' });
  }));
  api.post('/sessions/:id/restore', asyncRoute(async (req, res) => {
    const session = await conversationRepository.restore(res.locals.psyxUserId, req.params.id);
    return session ? responseData(res, session) : res.status(404).json({ ok: false, status: 'error', message: 'Archived PsyX session not found' });
  }));
  api.delete('/sessions/:id', asyncRoute(async (req, res) => {
    if (req.body?.confirmation !== 'PERMANENTLY DELETE') return res.status(400).json({ ok: false, status: 'error', code: 'PSYX_PERMANENT_DELETE_CONFIRMATION_REQUIRED', message: 'Permanent deletion requires explicit confirmation.' });
    const deleted = await conversationRepository.permanentlyDelete(res.locals.psyxUserId, req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, status: 'error', message: 'PsyX session not found' });
    review.forget?.(res.locals.psyxUserId, req.params.id);
    // The conversation is gone either way; a failed memory cleanup is logged, not reported as a failed delete.
    await stateRepository.forgetConversation(res.locals.psyxUserId, cleanText(req.params.id, 80))
      .catch(error => logger.error?.('PsyX could not forget a deleted conversation', { message: error.message }));
    return responseData(res, { id: req.params.id });
  }));

  api.get('/voice/status', asyncRoute(async (_req, res) => responseData(res, await voiceClient.status())));
  api.get('/voice/config', asyncRoute(async (_req, res) => responseData(res, await voiceClient.config())));
  api.get('/voice/catalog', asyncRoute(async (_req, res) => responseData(res, await voiceClient.catalog())));
  api.post('/voice/synthesize/stream', asyncRoute(async (req, res) => {
    const { relaySynthesisStream } = require('../../../src/services/voice/stream');
    const abort = new AbortController();
    const close = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', close);
    try {
      const response = await voiceClient.stream(req.body, abort.signal);
      await relaySynthesisStream(response, res);
    } catch (error) {
      if (res.headersSent || abort.signal.aborted) res.destroy();
      else throw error;
    } finally { res.off('close', close); }
  }));
  api.post('/voice/transcribe', express.raw({ type: 'audio/*', limit: config.voice?.maxAudioBytes || 25 * 1024 * 1024 }), asyncRoute(async (req, res) => {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!contentType.startsWith('audio/')) return res.status(415).json({ ok: false, status: 'error', code: 'PSYX_VOICE_AUDIO_TYPE_REQUIRED', message: 'An audio content type is required.' });
    const abort = new AbortController();
    const close = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', close);
    try {
      const result = await voiceClient.transcribe(req.body, { contentType,
        language: req.headers['x-psyx-language'], signal: abort.signal });
      if (!abort.signal.aborted) return responseData(res, result);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally { res.off('close', close); }
  }));
  api.post('/voice/synthesize', asyncRoute(async (req, res) => {
    // Request-scoped: { text, ttsProvider?, language?, voice? }. Nothing here changes VoiX defaults.
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const abort = new AbortController();
    const close = () => { if (!res.writableFinished) abort.abort(); };
    res.once('close', close);
    try {
      const audio = await voiceClient.synthesize({ text: body.text, ttsProvider: body.ttsProvider, language: body.language, voice: body.voice }, abort.signal);
      if (abort.signal.aborted) return;
      res.setHeader('Content-Type', audio.contentType);
      res.setHeader('Content-Length', audio.buffer.length);
      const applied = audio.applied || {};
      if (applied.ttsProvider) res.setHeader('X-PsyX-TTS-Provider', applied.ttsProvider);
      if (applied.language) res.setHeader('X-PsyX-TTS-Language', applied.language);
      if (applied.voice) res.setHeader('X-PsyX-TTS-Voice', applied.voice);
      return res.send(audio.buffer);
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { res.off('close', close); }
  }));

  const routingHandler = async (_req, res) => responseData(res, await provider.routing());
  api.get('/routing', asyncRoute(routingHandler));

  const chatHandler = async (req, res) => {
    const userId = res.locals.psyxUserId;
    const requested = domain.normalizeControl(req.body?.psyx || {});
    const action = requested.action ? domain.ACTION_CONFIG[requested.action] : null;
    const input = action?.persistedMessage || cleanText(req.body?.message, 12000);
    if (!input) return res.status(400).json({ ok: false, status: 'error', message: 'message is required' });

    const conversationId = cleanText(req.body?.conversationId, 80) || null;
    const context = conversationId ? await conversationRepository.context(userId, conversationId, 40) : [];
    if (conversationId && !context) return res.status(404).json({ ok: false, status: 'error', message: 'PsyX session not found' });
    const longitudinal = await stateRepository.read(userId);
    const recommendation = conversationId ? longitudinal.sessionDigests?.find(item => item.conversationId === conversationId)?.next : null;
    // A crisis signal overrides any stance: stay with the person, answer promptly.
    // Actions carry no words of their own, but a crisis in the last messages still holds.
    const safety = detectRecentCrisis(action ? '' : input, context || []);
    const resolved = domain.resolveControl(requested, recommendation);
    const control = safety ? { ...resolved, mode: 'talk', depth: 'normal', reason: '' } : resolved;
    const system = domain.composeSystemContext(longitudinal, control, { conversationId, safety, voice: req.body?.psyx?.source === 'voice' });
    const providerContext = domain.boundedContext(context || []);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const abortController = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abortController.abort(); });
    const heartbeat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
    const handlers = providerHandlers(res);
    streaming.set(userId, (streaming.get(userId) || 0) + 1);
    const location = domain.frontierLocation(frontierMode(longitudinal), control.depth);
    const applied = { mode: control.mode, depth: control.depth, auto: control.auto, reason: control.reason, safety: Boolean(safety), location };
    handlers.send('control', applied);
    if (safety) handlers.send('safety', safety);

    try {
      const result = await provider.stream({
        system,
        messages: providerContext,
        message: input,
        location,
        taskType: control.depth === 'deep' ? 'deep_reasoning' : 'analysis',
        think: control.depth === 'deep',
        options: { temperature: safety ? 0.4 : control.mode === 'challenge' ? 0.55 : 0.7 },
        timeoutMs: config.requestTimeoutMs,
        signal: abortController.signal
      }, handlers);
      if (abortController.signal.aborted) return;
      const assistant = cleanText(result.content || handlers.content(), 50000);
      if (!assistant) throw new Error('Inference provider returned an empty response');
      const session = await conversationRepository.saveCompletedTurn({
        userId,
        conversationId,
        userMessage: input,
        assistantMessage: assistant,
        action: control.action,
        model: result.model,
        provider: provider.id,
        routing: result.routing
      });
      const reviewScheduled = review.schedule(userId, session.id);
      handlers.send('done', {
        review: { scheduled: reviewScheduled },
        control: applied,
        response: assistant,
        conversationId: session.id,
        model: result.model,
        routing: result.routing,
        stats: result.stats,
        thinkingObserved: result.thinkingObserved
      });
      res.end();
    } catch (error) {
      if (!abortController.signal.aborted) {
        logger.error?.('PsyX inference failed', { code: error.code, message: error.message });
        handlers.send('error', { code: error.code || 'PSYX_INFERENCE_FAILED', message: error.message });
        res.end();
      }
    } finally {
      clearInterval(heartbeat);
      const remaining = (streaming.get(userId) || 1) - 1;
      if (remaining > 0) streaming.set(userId, remaining); else streaming.delete(userId);
    }
  };

  api.post('/chat/stream', asyncRoute(chatHandler));
  app.use('/api/psyx', api);

  app.use((error, _req, res, _next) => {
    logger.error?.('PsyX request failed', { code: error.code, message: error.message });
    if (res.headersSent) return res.end();
    const status = error.statusCode || (error.type === 'entity.too.large' ? 413 : 500);
    return res.status(status).json({ ok: false, status: 'error', code: error.code || 'PSYX_REQUEST_FAILED', message: status >= 500 ? 'PsyX request failed.' : error.message });
  });

  return app;
}

module.exports = { VERSION, createApp, serviceStatus, exportDocument };
