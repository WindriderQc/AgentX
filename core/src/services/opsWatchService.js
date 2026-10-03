'use strict';

/**
 * Operations watch: rules find, a model explains.
 *
 * Core already computes what needs attention (the ecosystem snapshot's
 * operational issues and the active alerts). This job turns that small,
 * deterministic list into one short prioritised report with a next action,
 * written by the `ops_watch` task's model: background work for a slow host.
 *
 * The model never decides what is wrong and can never hide a finding: when it
 * is unavailable the report carries the plain finding list. It runs only when
 * the set of findings changes. Delivery is the `ops-watch-report` alert rule,
 * one incident per distinct finding set; it goes stale and resolves on its own
 * once the findings are gone.
 *
 * Opt-in: switched on, with its interval and language, from the Nerve Center
 * (opsWatchSettings); OPS_WATCH_MS and OPS_WATCH_LANGUAGE only bootstrap it.
 */

const crypto = require('crypto');
const logger = require('../../config/logger');

const METRIC = 'ops_watch_report';
const RULE_ID = 'ops-watch-report';
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_DELAY_MS = 2 * 60 * 1000;
const MODEL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FINDINGS = 12;
const MAX_SUMMARY_CHARS = 1500;
// The alert count restates the alerts listed one by one below.
const SKIPPED_ISSUE_CODES = new Set(['active_alerts']);

const SYSTEM = `You are the operations watch of a home AI platform. You receive findings that monitoring rules already detected. Write a short report: order the findings by severity, and for each give the user impact in a few words and one concrete next action. Use only the findings given; do not add, guess or drop any. Plain text, at most 8 short lines, no preamble.`;

function watchIntervalMs(env = process.env) {
  const value = Number(env.OPS_WATCH_MS);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

function text(value, max = 200) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Findings from a snapshot: operational issues plus active alerts, minus this job's own. */
function collectFindings(snapshot) {
  const findings = [];
  for (const issue of snapshot?.operationalAttention?.issues || []) {
    if (!issue?.code || SKIPPED_ISSUE_CODES.has(issue.code)) continue;
    findings.push({
      key: `issue:${issue.code}:${issue.hostKey || ''}`,
      severity: issue.severity === 'critical' ? 'critical' : 'attention',
      text: text(issue.message)
    });
  }
  for (const alert of snapshot?.alerts || []) {
    if (!alert || alert.ruleId === RULE_ID) continue;
    const host = alert.context?.additionalData?.host || alert.context?.host || '';
    findings.push({
      key: `alert:${alert.ruleId || alert.title}:${host}`,
      severity: alert.severity === 'critical' ? 'critical' : 'attention',
      text: text([alert.title, alert.message].filter(Boolean).join(' — '), 300)
    });
  }
  const unique = [...new Map(findings.map(finding => [finding.key, finding])).values()];
  unique.sort((a, b) => (a.severity === b.severity ? a.key.localeCompare(b.key) : a.severity === 'critical' ? -1 : 1));
  return unique.slice(0, MAX_FINDINGS);
}

function fingerprintOf(findings) {
  return crypto.createHash('sha256').update(findings.map(finding => finding.key).join('\n')).digest('hex').slice(0, 16);
}

function plainList(findings) {
  return findings.map(finding => `- [${finding.severity}] ${finding.text}`).join('\n');
}

function createOpsWatch(deps = {}) {
  const buildSnapshot = deps.buildSnapshot
    || (() => require('../../routes/nerve-center').buildEcosystemSnapshot());
  const execute = deps.execute || ((request, options) => require('./inferenceService').executeInference(request, options));
  const evaluateEvent = deps.evaluateEvent || (event => require('./alertService').evaluateEvent(event));
  const now = deps.now || (() => new Date());
  let language = deps.language || process.env.OPS_WATCH_LANGUAGE || 'English';

  let latest = null;

  async function summarize(findings) {
    try {
      const result = await execute({
        callerDetail: 'ops-watch', taskType: 'ops_watch', stream: false, think: false,
        system: `${SYSTEM} Write in ${language}.`,
        prompt: `Findings:\n${plainList(findings)}`,
        options: { temperature: 0, num_predict: 400 }
      }, { timeoutMs: MODEL_TIMEOUT_MS });
      if (!result?.ok) return { summary: null, model: null, reason: result?.body?.code || `status ${result?.status}` };
      const summary = String(result.body?.response || result.body?.message?.content || result.body?.content || '')
        .trim().slice(0, MAX_SUMMARY_CHARS);
      return summary ? { summary, model: result.headers?.['X-Resolved-Model'] || null, reason: null }
        : { summary: null, model: null, reason: 'empty answer' };
    } catch (err) {
      return { summary: null, model: null, reason: err.message };
    }
  }

  async function check() {
    const findings = collectFindings(await buildSnapshot());
    const at = now().toISOString();
    if (findings.length === 0) {
      latest = { at, fingerprint: null, findingCount: 0, findings: [], summary: null, source: 'rules', model: null };
      return { findingCount: 0, summarized: false, emitted: false };
    }
    const fingerprint = fingerprintOf(findings);
    let summarized = false;
    if (!latest || latest.fingerprint !== fingerprint || latest.source !== 'model' || latest.language !== language) {
      const written = await summarize(findings);
      summarized = Boolean(written.summary);
      latest = {
        at, fingerprint, findingCount: findings.length, findings, language,
        summary: written.summary || plainList(findings),
        source: written.summary ? 'model' : 'rules',
        model: written.model, modelUnavailable: written.summary ? null : written.reason
      };
    }
    await evaluateEvent({
      component: 'operations', metric: METRIC, value: findings.length, threshold: 0, source: 'ops-watch',
      additionalData: {
        detector: METRIC,
        incidentKey: `ops-watch:${fingerprint}`,
        findingCount: findings.length,
        summary: latest.summary,
        reportSource: latest.source
      }
    });
    return { findingCount: findings.length, summarized, emitted: true, source: latest.source };
  }

  let timer = null;
  let running = false;
  async function tick() {
    if (running) return null;
    running = true;
    try {
      return await check();
    } catch (err) {
      logger.warn('[OpsWatch] check failed (non-fatal)', { error: err.message });
      return null;
    } finally {
      running = false;
    }
  }

  function start(intervalMs = watchIntervalMs(), { firstDelayMs = FIRST_DELAY_MS } = {}) {
    if (!intervalMs || timer) return false;
    timer = setTimeout(() => {
      tick();
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    }, Math.min(firstDelayMs, intervalMs));
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) { clearTimeout(timer); clearInterval(timer); }
    timer = null;
  }

  // Settings saved in the Nerve Center apply at once, in the process that
  // runs the watch (activate marks it; another process only stores them).
  let active = false;
  let intervalMs = 0;
  function apply(settings = {}) {
    if (settings.language) language = settings.language;
    intervalMs = settings.enabled === false ? 0 : Number(settings.intervalMs) || 0;
    stop();
    return intervalMs > 0 ? start(intervalMs) : false;
  }
  function activate(settings) { active = true; return apply(settings); }
  function configure(settings) { return active ? apply(settings) : false; }
  function deactivate() { active = false; stop(); }
  function setLanguage(value) { if (value) language = value; }
  const state = () => ({ active, scheduled: Boolean(timer), checking: running, intervalMs, language });

  return { check, tick, start, stop, activate, configure, deactivate, setLanguage, state, latest: () => latest };
}

let shared = null;
function getOpsWatch() {
  if (!shared) shared = createOpsWatch();
  return shared;
}

module.exports = { METRIC, RULE_ID, createOpsWatch, getOpsWatch, watchIntervalMs, collectFindings, fingerprintOf };
