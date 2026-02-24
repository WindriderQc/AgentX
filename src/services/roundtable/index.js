/**
 * Roundtable Service — Facade
 * Public API for multi-agent roundtable discussions
 *
 * Same pattern as src/services/benchmark/index.js:
 * re-exports sub-modules + SIGTERM handler for graceful shutdown.
 */

const { EventEmitter } = require('events');
const logger = require('../../../config/logger');
const Roundtable = require('../../../models/Roundtable');
const { runRoundtable, createRoundtable, getRoundtable, listRoundtables, emitterRegistry } = require('./orchestrator');
const { formatTranscript, formatTelegramSummary } = require('./formatters');
const { DEFAULT_PANEL, DEFAULT_SYNTHESIZER } = require('./defaults');
const { notifyCompletion } = require('./notifier');
const { analyzeQuality } = require('./qualityAnalyzer');

// Track active roundtable for SIGTERM cleanup
let activeRoundtableId = null;

function setActiveRoundtable(id) { activeRoundtableId = id; }
function getActiveRoundtableId() { return activeRoundtableId; }

/**
 * Create + fire-and-forget execution
 * Returns the pending doc immediately; orchestrator runs in background.
 */
async function startRoundtable(options) {
  const doc = await createRoundtable(options);
  const id = doc._id.toString();
  const notifyConfig = options.notify || null;
  const enableScoring = options.enableScoring !== false; // Opt-out, enabled by default

  // Create a streaming emitter for this roundtable
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20); // Allow multiple SSE clients
  emitterRegistry.set(id, emitter);

  // Fire-and-forget — caller gets the pending doc back immediately
  setActiveRoundtable(id);
  runRoundtable(id, emitter)
    .then(async () => {
      const completedDoc = await getRoundtable(id);
      if (!completedDoc) return;

      // Run quality scoring (non-blocking, after completion)
      if (enableScoring && completedDoc.status === 'completed') {
        try {
          await analyzeQuality(id);
        } catch (err) {
          logger.error('Roundtable quality analysis failed', { id, error: err.message });
        }
      }

      // Send notifications on completion
      if (notifyConfig) {
        try {
          // Re-fetch to include quality scores
          const finalDoc = enableScoring ? await getRoundtable(id) : completedDoc;
          await notifyCompletion(finalDoc, notifyConfig);
        } catch (err) {
          logger.error('Roundtable notification failed', { id, error: err.message });
        }
      }
    })
    .catch(err => logger.error('Background roundtable failed', { id: doc._id, error: err.message }))
    .finally(() => {
      if (activeRoundtableId === id) {
        setActiveRoundtable(null);
      }
    });

  return doc;
}

/**
 * Get the streaming emitter for an active roundtable
 * @param {string} id - Roundtable ID
 * @returns {EventEmitter|null}
 */
function getEmitter(id) {
  return emitterRegistry.get(id) || null;
}

// Graceful shutdown — mark active roundtable as failed
process.on('SIGTERM', async () => {
  if (!activeRoundtableId) return;

  logger.warn('SIGTERM — marking active roundtable as failed', { id: activeRoundtableId });
  try {
    await Roundtable.updateOne(
      { _id: activeRoundtableId, status: 'running' },
      { $set: { status: 'failed', error: 'Process terminated (SIGTERM)', completedAt: new Date() } }
    );
  } catch (err) {
    logger.error('Failed to mark roundtable on SIGTERM', { error: err.message });
  }
});

module.exports = {
  startRoundtable,
  runRoundtable,
  createRoundtable,
  getRoundtable,
  listRoundtables,
  formatTranscript,
  formatTelegramSummary,
  DEFAULT_PANEL,
  DEFAULT_SYNTHESIZER,
  getActiveRoundtableId,
  getEmitter,
  analyzeQuality
};
