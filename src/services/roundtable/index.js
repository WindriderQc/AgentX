/**
 * Roundtable Service — Facade
 * Public API for multi-agent roundtable discussions
 *
 * Same pattern as src/services/benchmark/index.js:
 * re-exports sub-modules + SIGTERM handler for graceful shutdown.
 */

const logger = require('../../../config/logger');
const Roundtable = require('../../../models/Roundtable');
const { runRoundtable, createRoundtable, getRoundtable, listRoundtables } = require('./orchestrator');
const { formatTranscript, formatTelegramSummary } = require('./formatters');
const { DEFAULT_PANEL, DEFAULT_SYNTHESIZER } = require('./defaults');

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

  // Fire-and-forget — caller gets the pending doc back immediately
  setActiveRoundtable(doc._id.toString());
  runRoundtable(doc._id.toString())
    .catch(err => logger.error('Background roundtable failed', { id: doc._id, error: err.message }))
    .finally(() => {
      if (activeRoundtableId === doc._id.toString()) {
        setActiveRoundtable(null);
      }
    });

  return doc;
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
  getActiveRoundtableId
};
