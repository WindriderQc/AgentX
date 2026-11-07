'use strict';

// Read-only diagnosis. Existing host reads supply parallelism; this module
// never probes an endpoint, dispatches inference or changes a route.
const { modelsMatch } = require('../helpers/modelNameNormalization');
const { defaultsFor } = require('./conversationPreferences/catalog');

const WINDOW_MS = 15 * 60 * 1000;
const HOST_MAX_AGE_MS = 60 * 1000;
const CONTRACT = 'household-runtime-v1';
const SCOPES = { nestor: { pack: 'personal_operator', brain: 'private' }, family: { pack: 'kidx_nestor', brain: 'family' } };
const hostKey = value => typeof value === 'string' ? value.trim().replace(/\/+$/, '').toLowerCase() : '';
const fresh = (value, now, maxAge) => {
  const at = new Date(value).getTime();
  return value != null && Number.isFinite(at) && at <= now && now - at <= maxAge;
};
const same = (left, right) => Boolean(left?.host && right?.host && hostKey(left.host) === hostKey(right.host)
  && modelsMatch(left.model, right.model));

function configuredTargets({ env, routes, hosts, fixedTask }) {
  const taskTarget = task => {
    const row = routes[task];
    // Do not guess the active topology role or a scheduler recommendation.
    return row?.model && row.host && !row.role && !row.target && fixedTask(task, row.host) && hosts[row.host]
      ? { model: row.model, host: hosts[row.host] } : null;
  };
  const voiceTask = String(env.HOUSEHOLD_VOICE_TASK || '').trim() || 'voice_persona_chat';
  const reviewTask = env.HOUSEHOLD_BRAIN_TASK || 'master_brain';
  // Other tasks may also serve typed turns: those receipts do not prove voice.
  const voice = voiceTask === 'voice_persona_chat' ? taskTarget(voiceTask) : null;
  const explicitReview = reviewTask !== 'household_review' && env.HOUSEHOLD_BRAIN_MODEL && env.HOUSEHOLD_BRAIN_HOST_URL;
  const review = explicitReview
    ? { model: String(env.HOUSEHOLD_BRAIN_MODEL).replace(/^ollama\//, ''), host: env.HOUSEHOLD_BRAIN_HOST_URL }
    : (!env.HOUSEHOLD_BRAIN_MODEL && !env.HOUSEHOLD_BRAIN_HOST_URL) || reviewTask === 'household_review'
      ? taskTarget(reviewTask) : null;
  return { voice, review, voiceTask, reviewTask };
}

function diagnose({ surface, enabled, targets, receipts = {}, hostObservations = [], configVersion, now }) {
  const result = (status, reason, extra = {}) => ({ surface, status, reason, ...extra });
  if (enabled === false) return result('inactive', 'review_disabled');
  if (enabled !== true || !configVersion || !targets.voice || !targets.review) return result('unknown', 'configuration_unresolved');
  // Different static routes do not prove where active native consumers run.
  if (!same(targets.voice, targets.review)) return result('unknown', 'configured_targets_differ');
  const validReceipt = (row, target, task, detail) => row?.source === 'core-observed' && row.status === 'success'
    && row.consumerContract === CONTRACT && row.taskType === task && detail(row.callerDetail)
    && row.routeDecision?.configVersion === configVersion
    && row.routeDecision?.attribution?.consumerContract === CONTRACT
    && fresh(row.timestamp, now, WINDOW_MS) && same(row, target);
  const scope = SCOPES[surface];
  if (!validReceipt(receipts.voice, targets.voice, targets.voiceTask, value => typeof value === 'string' && value.startsWith(`agentx-household/${scope.pack}/`))
    || !validReceipt(receipts.review, targets.review, targets.reviewTask, value => value === `agentx-household/brain/${scope.brain}`)) {
    return result('unknown', 'recent_consumers_unverified');
  }
  const observation = hostObservations.find(row => hostKey(row.hostUrl) === hostKey(targets.voice.host));
  if (observation?.live?.online !== true || !fresh(observation.live.observedAt, now, HOST_MAX_AGE_MS)) {
    return result('unknown', 'host_observation_unavailable');
  }
  const parallelism = observation.live.modelParallelism?.find(row => modelsMatch(row.model, targets.voice.model));
  // The architecture list mirrors one scheduler version; it is not a native
  // slot measurement. Require a recent recorded process/startup observation.
  const slots = observation.ollamaConcurrency;
  const compatible = (parallelism?.reason === 'architecture' && parallelism.requestSlots === 1)
    || (parallelism?.reason === 'server_setting' && parallelism.requestSlots === null);
  if (!compatible
    || slots?.numParallel !== 1 || !['process-environment', 'startup-log'].includes(slots.source)
    || !fresh(slots.observedAt, now, WINDOW_MS)) return result('unknown', 'sequential_model_unverified');
  return result('warning', 'shared_sequential_model', {
    model: targets.voice.model, host: targets.voice.host,
    voiceObservedAt: new Date(receipts.voice.timestamp).toISOString(),
    reviewObservedAt: new Date(receipts.review.timestamp).toISOString(),
    hostObservedAt: new Date(observation.live.observedAt).toISOString(),
    slotsObservedAt: new Date(slots.observedAt).toISOString(), slotsSource: slots.source
  });
}

async function readVoiceReviewContention(hostObservations, options = {}) {
  const now = options.now ?? Date.now(), env = options.env || process.env;
  const unknown = reason => ({ windowMs: WINDOW_MS, checkedAt: new Date(now).toISOString(),
    surfaces: Object.keys(SCOPES).map(surface => ({ surface, status: 'unknown', reason })) });
  try {
    const routing = options.routing || require('./modelRouterConfig');
    await routing.ensureTaskModelOverridesLoaded();
    const configVersion = routing.getRoutingConfigVersion();
    const targets = configuredTargets({ env, routes: routing.getEffectiveTaskModels(), hosts: routing.HOSTS,
      fixedTask: options.fixedTask || require('./modelRouterDefaults').staysOnConfiguredHost });
    const preferences = options.preferences || require('./conversationPreferences/service').createConversationPreferences({ env });
    const Log = options.Log || require('../../models/InferenceLog');
    const surfaces = await Promise.all(Object.entries(SCOPES).map(async ([surface, scope]) => {
      const prefs = await preferences.forOwner({ ownerId: 'default', surface, defaults: defaultsFor(surface, env) }).read();
      const enabled = prefs.values.backgroundReview;
      let receipts;
      if (enabled === true && same(targets.voice, targets.review)) {
        const receipt = (taskType, callerDetail) => Log.findOne({ source: 'core-observed', status: 'success',
          consumerContract: CONTRACT, taskType, callerDetail,
          timestamp: { $gte: new Date(now - WINDOW_MS), $lte: new Date(now) } })
          .sort({ timestamp: -1 }).select('host model timestamp source status consumerContract taskType callerDetail routeDecision.configVersion routeDecision.attribution.consumerContract')
          .maxTimeMS(1000).lean();
        const [voice, review] = await Promise.all([
          receipt(targets.voiceTask, new RegExp(`^agentx-household/${scope.pack}/`)),
          receipt(targets.reviewTask, `agentx-household/brain/${scope.brain}`)
        ]);
        receipts = { voice, review };
      }
      return diagnose({ surface, enabled, targets, receipts, hostObservations, configVersion, now });
    }));
    if (routing.getRoutingConfigVersion() !== configVersion) return unknown('configuration_changed');
    return { windowMs: WINDOW_MS, checkedAt: new Date(now).toISOString(), surfaces };
  } catch {
    // Missing preferences, receipts or configuration never become reassurance.
    return unknown('diagnosis_unavailable');
  }
}

module.exports = { configuredTargets, diagnose, readVoiceReviewContention, WINDOW_MS, HOST_MAX_AGE_MS };
