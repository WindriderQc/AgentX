'use strict';

const { getPinnedEntries } = require('./hostPinPrimitives');
const { projectHostPreferenceForRead } = require('./hostPreferencePublicProjection');
const { detectorState } = require('./alertRuleLifecycle');
const { normalizeHostPreferenceIdentity } = require('./hostPreferenceIdentity');

const HISTORY_AGE_MS = 24 * 60 * 60 * 1000;
const link = (label, href) => ({ label, href });
const INFERENCE = '/nerve-center#sectionInferenceHealth';
const PINS = '/nerve-center#sectionCluster';
const RULES = '/nerve-center#sectionAlerts';

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function evidence({ at, resultAt = null, outcome = 'unknown', source, id = null, event = null, reason = null, subject = null }, now) {
  const timestamp = iso(at);
  const ageMs = timestamp ? now.getTime() - new Date(timestamp).getTime() : null;
  return { timestamp, resultTimestamp: iso(resultAt), outcome: timestamp && ageMs >= 0 ? outcome : 'unknown', source, id: id ? String(id) : null,
    event, reason, subject, ageMs,
    freshness: ageMs === null ? 'not_observed' : ageMs < 0 ? 'unknown' : ageMs > HISTORY_AGE_MS ? 'historical' : 'recent' };
}

function latest(rows = [], field = 'timestamp') {
  return rows.reduce((chosen, row) => iso(row[field]) && (!chosen || new Date(row[field]) >= new Date(chosen[field])) ? row : chosen, undefined);
}

function projectSelfHealing(sources, now = new Date()) {
  const value = name => sources[name]?.value;
  const available = name => sources[name] && !sources[name].unavailable;
  const rows = [];
  function add(id, name, mode, enabled, configSource, last, operator, limit, running = null) {
    rows.push({ id, name, mode, enabled: typeof enabled === 'boolean' ? enabled : null,
      configurationSource: configSource, running: typeof running === 'boolean' ? running : null,
      last: evidence(last || { source: configSource }, now), operator, limit });
  }

  const fallback = value('fallback');
  const ladders = value('ladders');
  add('routing-fallbacks', 'Recorded routing fallbacks', 'autonomous', null, 'per-caller routing configuration',
    fallback && { at: fallback.timestamp, outcome: fallback.status || 'unknown', source: 'InferenceLog',
      id: fallback._id, event: 'fallbackUsed', reason: fallback.fallbackReason },
    link('Routing diagnostics', '/nerve-center#sectionInference'),
    'No global failover switch. A recorded route is evidence of that request only.');
  add('task-fallbacks', 'Task fallback ladders', 'autonomous', ladders ? ladders.configuredTasks.length > 0 : null,
    'taskFallbackLadder', null, link('Routing configuration', '/nerve-center#sectionConfig'),
    ladders ? `${ladders.configuredTasks.length} configured task(s); ${ladders.configurationErrors.length} configuration error(s). Execution evidence is in recorded routing fallbacks.` : 'Configuration unavailable.');

  const watchdog = value('watchdog');
  const probe = latest(watchdog?.hosts || [], 'lastProbeAt');
  add('watchdog-probes', 'Watchdog inference detection', 'detection', null, 'ollamaWatchdogService',
    probe && { at: probe.lastProbeAt, source: 'watchdog process observation', id: probe.hostId,
      event: 'inference_probe', outcome: probe.lastResult?.ok === false ? 'failed'
        : probe.lastResult?.ok === true && probe.lastResult.mode === 'loaded-model' ? 'success' : 'unknown',
      reason: probe.lastResult?.reason }, link('Inference health', INFERENCE),
    'Existing probes only; this read sends none. Observations are local to the responding process and reset on restart.', watchdog?.isRunning);

  const history = watchdog?.history || [];
  const jam = latest(history.filter(event => event.type === 'jam_detected'));
  // Manual unjams share reload events with the daemon. Fence by host and the
  // next trigger so a manual action can never prove autonomous recovery.
  const following = jam ? history.slice(history.indexOf(jam) + 1) : [];
  const nextIndex = following.findIndex(event => event.hostUrl === jam.hostUrl
    && ['jam_detected', 'force_unjam'].includes(event.type));
  const episode = (nextIndex < 0 ? following : following.slice(0, nextIndex))
    .filter(event => event.hostUrl === jam?.hostUrl);
  const unjam = latest(episode.filter(event => /^unjam_(success|failed|deferred)$/.test(event.type)));
  add('watchdog-unjam', 'Watchdog jam recovery', 'autonomous', null, 'ollamaWatchdogService',
    jam && { at: jam.timestamp, resultAt: unjam?.timestamp, source: 'watchdog process history', event: 'jam_detected', id: jam.hostId,
      outcome: unjam?.type === 'unjam_success' ? 'unload_completed' : unjam?.type === 'unjam_failed' ? 'failed' : unjam?.type === 'unjam_deferred' ? 'deferred' : 'unknown',
      reason: unjam?.type }, link('Inspect watchdog evidence', INFERENCE),
    'Only a retained jam_detected episode qualifies. Completed unload does not prove reload or GPU recovery.', watchdog?.isRunning);
  const reloads = episode.filter(event => ['reload_success', 'reload_failed', 'pin_restore_triggered', 'pin_restore_failed'].includes(event.type));
  const reload = latest(reloads);
  add('watchdog-reload', 'Watchdog reload after unjam', 'autonomous', watchdog?.config?.reloadAfterUnjam,
    'ollamaWatchdogService.config.reloadAfterUnjam', reload && { at: jam.timestamp, resultAt: reload.timestamp, subject: reload.model || null,
      source: 'watchdog process history', event: 'jam_detected', id: jam?.hostId,
      outcome: reload.type === 'reload_success' ? 'model_reload_completed' : reload.type.endsWith('failed') ? 'failed' : 'unknown',
      reason: reload.type }, link('Pins and models', PINS),
    'A pin_restore_triggered event alone has no verified result. Other models in the episode may have different outcomes.', watchdog?.isRunning);

  const recovery = latest(history.filter(event => ['probe_recovered', 'caller_abort_recovered', 'runtime_disconnect_recovered', 'recovery_required'].includes(event.type)));
  add('watchdog-quarantine', 'Watchdog quarantine reconciliation', 'autonomous', null, 'ollamaWatchdogService',
    recovery && { at: recovery.timestamp, source: 'watchdog process history', id: recovery.hostId,
      event: recovery.type, outcome: recovery.type === 'recovery_required' ? 'unknown' : 'quarantine_released' },
    link('Runtime recovery', INFERENCE), 'Release evidence does not establish model or GPU health.', watchdog?.isRunning);

  const pinData = value('pins');
  for (const raw of pinData?.rows || []) {
    const pref = projectHostPreferenceForRead(normalizeHostPreferenceIdentity(raw));
    for (const [index, pin] of getPinnedEntries(pref).entries()) {
      add(`pin:${pref.hostKey}:${index}`, `Pin auto-restore · ${pref.displayName || pref.hostKey} · ${pin.model}`,
        'autonomous', pin.autoRestore, 'HostPreference.pinnedModels.autoRestore', null,
        link('Manage pins', PINS),
        'No dedicated automatic restore receipt is retained. Host status, loaded models and record update time do not prove a restore ran.', value('pinDaemon')?.running);
    }
  }

  const alertData = value('alerts') || [];
  const alertByRule = new Map(alertData.map(item => [item._id, item.alert]));
  const engineIds = available('engine') ? new Set(value('engine').map(rule => rule.id)) : null;
  for (const rule of value('rules')?.rows || []) {
    const state = detectorState(rule);
    const alert = alertByRule.get(rule.ruleId);
    add(`rule:${rule.ruleId}`, rule.name || rule.ruleId, 'detection', state === 'active', 'AlertRule',
      alert && { at: alert.timestamp, source: 'Alert', id: alert._id, event: alert.context?.metric || rule.ruleId,
        outcome: 'detected', reason: alert.status }, link('Alert rules', RULES),
      state === 'retired_by_design' ? 'Retired producer; historical rule retained.'
        : 'An alert proves detection, not repair. Resolved or acknowledged status does not establish recovery.', engineIds ? engineIds.has(rule.ruleId) : null);
  }

  const delivery = value('delivery');
  const localConfigured = available('rules') ? (value('rules').rows.some(rule => rule.enabled
    && (rule.channels || []).includes('local_log')) ? true : value('rules').truncated ? null : false) : null;
  add('local-notification', 'Local alert notifications', 'notification', localConfigured, 'AlertRule.channels',
    delivery && { at: delivery.delivery?.local_log?.sentAt, source: 'Alert.delivery.local_log', id: delivery._id,
      event: delivery.ruleId, outcome: delivery.delivery.local_log.sent === true ? 'logged' : 'failed' },
    link('Alert rules', RULES), 'Core local logging receipt only; external delivery is independently owned.');
  for (const [channel, config] of Object.entries(value('notifications') || {})) {
    add(`notification:${channel}`, `${channel} notifications`, 'notification', config.enabled, 'notificationService', null,
      link('Alert rules', RULES), config.external ? 'External adapter owns delivery. Core has no adapter execution evidence.' : 'No delivery evidence.');
  }

  const watchSettings = value('watchSettings');
  const watch = value('watch');
  add('ops-watch', 'Operations watch', 'detection', watchSettings?.enabled, `opsWatchSettings:${watchSettings?.source || 'unavailable'}`,
    watch?.latest && { at: watch.latest.at, source: 'opsWatch process report', event: 'operations_check',
      outcome: watch.latest.findingCount === 0 ? 'no_findings' : 'findings_recorded' },
    link('Operations watch settings', '/nerve-center#sectionOpsWatch'),
    'The report does not repair findings. It may come from a manual check; automatic origin is not retained.', watch?.state?.scheduled);

  return {
    observedAt: now.toISOString(), readOnly: true, historyAgeMs: HISTORY_AGE_MS, rows,
    sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, {
      status: source.unavailable ? 'unavailable' : 'available',
      truncated: Boolean(source.value?.truncated || (name === 'alerts' && source.value?.length > 200))
    }])),
    scope: 'Existing routing, pin restoration, watchdog, alert rules and notifications, and operations watch. Not an inventory of every scheduled job. Recent means within 24 hours; historical evidence is not current health. Process evidence may be absent on a standby process.',
    manual: [
      { name: 'Model reload and pin changes', operator: link('Pins and models', PINS) },
      { name: 'Runtime restart', operator: link('Runtime recovery procedure', 'https://github.com/WindriderQc/AgentX/blob/main/docs/OPERATIONS.md#profiler-restoration-and-unknown-recovery') },
      { name: 'Placement and topology changes', operator: link('Principal model and topology', '/nerve-center#sectionModel') }
    ]
  };
}

module.exports = { projectSelfHealing, HISTORY_AGE_MS };
