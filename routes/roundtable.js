/**
 * Roundtable Routes
 * REST endpoints for multi-agent roundtable discussions
 *
 * POST /           — Create + fire-and-forget execution
 * GET  /           — List roundtables (paginated)
 * GET  /defaults   — Default panel system prompts
 * GET  /:id        — Get full roundtable document
 * GET  /:id/stream — SSE stream for live token updates
 * GET  /:id/transcript — Markdown transcript
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const roundtableService = require('../src/services/roundtable');

// Optional middleware (same pattern as agents.js)
let optionalAuth, optionalWorkspaceContext;
try {
  ({ optionalAuth } = require('../src/middleware/auth'));
} catch { optionalAuth = (req, res, next) => next(); }
try {
  ({ optionalWorkspaceContext } = require('../src/middleware/workspace'));
} catch { optionalWorkspaceContext = (req, res, next) => next(); }

/**
 * POST / — Start a new roundtable discussion
 * Body: { question, rounds?, panel?, synthesizer?, tags?, source? }
 * Returns: { _id, status: 'pending', question }
 */
router.post('/', optionalAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const { question, rounds, panel, synthesizer, tags, source, notify, enableScoring } = req.body;

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({ status: 'error', message: 'question is required' });
    }

    if (question.length > 5000) {
      return res.status(400).json({ status: 'error', message: 'question exceeds 5000 character limit' });
    }

    const doc = await roundtableService.startRoundtable({
      question: question.trim(),
      rounds,
      panel,
      synthesizer,
      workspaceId: req.workspaceId || null,
      userId: req.session?.userId || null,
      source: source || 'api',
      tags: tags || [],
      notify: notify || null,
      enableScoring: enableScoring !== false
    });

    res.status(201).json({
      _id: doc._id,
      status: doc.status,
      question: doc.question,
      rounds: doc.rounds
    });
  } catch (err) {
    logger.error('POST /api/roundtable failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET / — List roundtables
 * Query: limit, skip, workspaceId
 */
router.get('/', optionalAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = parseInt(req.query.skip) || 0;
    const workspaceId = req.query.workspaceId || req.workspaceId || null;

    const { docs, total } = await roundtableService.listRoundtables({ workspaceId, limit, skip });

    res.json({ status: 'ok', data: docs, total, limit, skip });
  } catch (err) {
    logger.error('GET /api/roundtable failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /defaults — Return default panel system prompts for UI preview
 */
router.get('/defaults', (req, res) => {
  const { DEFAULT_PANEL, DEFAULT_SYNTHESIZER } = require('../src/services/roundtable/defaults');
  const prompts = {};
  for (const agent of DEFAULT_PANEL) {
    prompts[agent.agentId] = agent.systemPrompt;
  }
  prompts['synthesizer'] = DEFAULT_SYNTHESIZER.systemPrompt;
  res.json({ status: 'ok', data: prompts });
});

/**
 * GET /:id — Get full roundtable document
 */
router.get('/:id', async (req, res) => {
  try {
    const doc = await roundtableService.getRoundtable(req.params.id);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });
    res.json({ status: 'ok', data: doc });
  } catch (err) {
    logger.error('GET /api/roundtable/:id failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /:id/stream — SSE stream for live token updates
 * Events: turn-start, turn-chunk, turn-done, synthesis-start, synthesis-chunk, synthesis-done, done
 */
router.get('/:id/stream', async (req, res) => {
  try {
    const doc = await roundtableService.getRoundtable(req.params.id);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });

    // If already completed, send final event immediately
    if (['completed', 'failed', 'timeout'].includes(doc.status)) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`event: done\ndata: ${JSON.stringify({ status: doc.status, totalDurationMs: doc.totalDurationMs })}\n\n`);
      res.end();
      return;
    }

    const emitter = roundtableService.getEmitter(req.params.id);
    if (!emitter) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(`event: done\ndata: ${JSON.stringify({ status: 'no-stream', message: 'No active stream for this roundtable' })}\n\n`);
      res.end();
      return;
    }

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    const onChunk = (data) => {
      try {
        res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
        if (data.type === 'done') cleanup();
      } catch { cleanup(); }
    };

    const cleanup = () => {
      clearInterval(heartbeat);
      emitter.removeListener('chunk', onChunk);
      if (!res.writableEnded) res.end();
    };

    emitter.on('chunk', onChunk);
    req.on('close', cleanup);

  } catch (err) {
    logger.error('GET /api/roundtable/:id/stream failed', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  }
});

/**
 * GET /:id/transcript — Markdown transcript
 */
router.get('/:id/transcript', async (req, res) => {
  try {
    const doc = await roundtableService.getRoundtable(req.params.id);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });

    const transcript = roundtableService.formatTranscript(doc);
    res.type('text/markdown').send(transcript);
  } catch (err) {
    logger.error('GET /api/roundtable/:id/transcript failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
