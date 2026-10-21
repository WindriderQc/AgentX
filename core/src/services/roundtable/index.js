/**
 * Roundtable Service — Facade
 *
 * Public surface for multi-agent deliberation. Start a discussion
 * fire-and-forget (returns the pending doc immediately), subscribe to
 * streaming events, and fetch the finished record.
 */

const logger = require('../../../config/logger');
const Roundtable = require('../../../models/Roundtable');
const {
  runRoundtable,
  createRoundtable,
  cancelRoundtable,
  getRoundtable,
  listRoundtables,
  reconcileStaleRoundtables,
  emitterRegistry
} = require('./orchestrator');
const { formatTranscript, formatCompactSummary } = require('./formatters');
const {
  DEFAULT_PANEL,
  DEFAULT_SYNTHESIZER,
  COUNCIL_OPTIONS,
  withDefaultModel
} = require('./defaults');
const { resolveCouncilDefaults } = require('./defaultResolver');
const { analyzeQuality } = require('./qualityAnalyzer');
const {
  addInterjection,
  setDecision
} = require('./controls');
const { validateRuntimeConfiguration } = require('./runtimeParticipantAdapter');
const { LiveRunEmitter } = require('./liveRun');

// One Council runs at a time in this process; a second start is refused (409).
const activeRoundtableIds = new Set();
let startInProgress = false;
function getActiveRoundtableId() { return [...activeRoundtableIds].pop() || null; }

function refuseWhileActive() {
  if (!activeRoundtableIds.size && !startInProgress) return;
  const err = new Error('A Council is already running: attach to it or stop it first');
  err.status = 409;
  err.code = 'COUNCIL_ACTIVE';
  err.activeId = getActiveRoundtableId();
  throw err;
}

/**
 * Create + fire-and-forget execution. Returns the pending doc; the
 * orchestrator runs in the background. Caller should subscribe to the
 * streaming emitter (via getEmitter) if they want live updates.
 */
function firstExplicitPanelModel(panel) {
  if (!Array.isArray(panel)) return '';
  const participant = panel.find((entry) =>
    String(entry?.runtime || 'model').toLowerCase() === 'model'
    && String(entry?.model || '').trim()
  );
  return String(participant?.model || '').trim();
}

async function resolveStartOptions(options = {}) {
  const hasPanel = Object.prototype.hasOwnProperty.call(options, 'panel');
  const callerModel = String(options.synthesizer?.model || '').trim()
    || firstExplicitPanelModel(options.panel);
  let defaults = null;

  if (callerModel) {
    defaults = withDefaultModel(callerModel);
  } else if (!hasPanel || !String(options.synthesizer?.model || '').trim()) {
    defaults = await resolveCouncilDefaults();
  }

  const synthesizer = {
    ...(defaults?.synthesizer || DEFAULT_SYNTHESIZER),
    ...(options.synthesizer || {})
  };
  synthesizer.model = String(options.synthesizer?.model || defaults?.synthesizer?.model || '').trim();

  return {
    ...options,
    panel: hasPanel ? options.panel : defaults?.panel,
    synthesizer
  };
}

async function startRoundtable(options = {}) {
  refuseWhileActive();
  startInProgress = true;
  try {
    return await launchRoundtable(options);
  } finally {
    startInProgress = false;
  }
}

async function launchRoundtable(options) {
  const resolvedOptions = await resolveStartOptions(options);
  // An agent presiding as chair is a runtime participant too.
  const chair = resolvedOptions.synthesizer?.runtime === 'openclaw'
    ? [{ agentId: resolvedOptions.synthesizer.agentId, runtime: 'openclaw' }] : [];
  validateRuntimeConfiguration([...(resolvedOptions.panel || DEFAULT_PANEL), ...chair]);
  const doc = await createRoundtable(resolvedOptions);
  const id = doc._id.toString();
  const enableScoring = resolvedOptions.enableScoring === true;

  const emitter = new LiveRunEmitter();
  emitterRegistry.set(id, emitter);

  activeRoundtableIds.add(id);
  runRoundtable(id, emitter)
    .then(async () => {
      const completedDoc = await getRoundtable(id);
      if (!completedDoc) return;

      if (enableScoring && completedDoc.status === 'completed') {
        try {
          await analyzeQuality(id);
        } catch (err) {
          logger.error('Roundtable quality analysis failed', { id, error: err.message });
        }
      }
    })
    .catch((err) => logger.error('Background roundtable failed', { id, error: err.message }))
    .finally(() => activeRoundtableIds.delete(id));

  return doc;
}

function getEmitter(id) {
  return emitterRegistry.get(id) || null;
}

// Graceful shutdown — mark every active roundtable as failed so the UI can surface it.
process.on('SIGTERM', async () => {
  if (!activeRoundtableIds.size) return;
  const ids = [...activeRoundtableIds];
  logger.warn('SIGTERM — marking active roundtables as failed', { ids });
  try {
    await Roundtable.updateMany(
      { _id: { $in: ids }, status: 'running' },
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
  formatCompactSummary,
  DEFAULT_PANEL,
  DEFAULT_SYNTHESIZER,
  COUNCIL_OPTIONS,
  getCouncilDefaults: resolveCouncilDefaults,
  resolveStartOptions,
  getActiveRoundtableId,
  reconcileStaleRoundtables,
  getEmitter,
  analyzeQuality,
  addInterjection,
  setDecision,
  cancelRoundtable
};
