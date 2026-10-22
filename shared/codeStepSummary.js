// Bounded public projection of the private runner-owned code-step ledger.
// Commands, model text, verifier output and workspace paths never enter this
// contract. Core persists only this whitelist and the browser validates it
// again before rendering.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const api = factory();
    api.mountBrowser = app => app.get('/js/code-step-summary.js', (_req, res) => res.sendFile(__filename));
    module.exports = api;
  } else root.AgentXCodeStepSummary = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const SCHEMA = 'agentx.code-step-summary/v1';
  const STATES = ['pending', 'running', 'passed', 'failed'];
  const TEST_OUTCOMES = ['passed', 'failed', 'unknown'];
  const BUDGET_SOURCES = ['agent_workload', 'speed_knee', 'default'];
  const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
  const SHA40 = /^[a-f0-9]{40}$/;
  const SHA256 = /^[a-f0-9]{64}$/;

  function fail(message) { throw new Error(`Invalid code-step summary: ${message}`); }
  function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
    return value;
  }
  function identifier(value, name, max = 80) {
    const text = String(value ?? '').trim();
    if (!text || text.length > max || !IDENTIFIER.test(text)) fail(`${name} must be a bounded identifier`);
    return text;
  }
  function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer from ${min} through ${max}`);
    return value;
  }
  function title(value, name) {
    if (typeof value !== 'string') fail(`${name} must be text`);
    const text = value.trim();
    if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/.test(text)) fail(`${name} must be one bounded display line`);
    return text;
  }

  function normalizeTest(value, path) {
    const raw = object(value, path);
    const outcome = String(raw.outcome || '');
    if (!TEST_OUTCOMES.includes(outcome)) fail(`${path}.outcome is not supported`);
    const result = { profile: identifier(raw.profile, `${path}.profile`, 120), outcome };
    if (raw.durationMs != null) result.durationMs = integer(raw.durationMs, `${path}.durationMs`, { max: 604_800_000 });
    return result;
  }

  function normalizeStep(value, index) {
    const path = `steps[${index}]`;
    const raw = object(value, path);
    const state = String(raw.state || '');
    if (!STATES.includes(state)) fail(`${path}.state is not supported`);
    if (!Array.isArray(raw.tests) || raw.tests.length > 16) fail(`${path}.tests must contain at most 16 focused test results`);
    const tests = raw.tests.map((test, testIndex) => normalizeTest(test, `${path}.tests[${testIndex}]`));
    const commit = raw.commit == null || raw.commit === '' ? null : String(raw.commit).trim().toLowerCase();
    if (commit != null && !SHA40.test(commit)) fail(`${path}.commit must be a Git commit SHA`);
    if (state === 'passed' && (!commit || !tests.length || tests.some(test => test.outcome !== 'passed'))) {
      fail(`${path} passed state requires one commit and passing focused tests`);
    }
    if (state !== 'passed' && commit) fail(`${path} may retain a commit only after passing focused tests`);
    return { id: identifier(raw.id, `${path}.id`), title: title(raw.title, `${path}.title`), state,
      ...(commit && { commit }), tests };
  }

  function normalize(value) {
    const raw = object(value, 'codeSteps');
    if (raw.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
    const planFingerprint = String(raw.planFingerprint || '').trim().toLowerCase();
    if (!SHA256.test(planFingerprint)) fail('planFingerprint must be a SHA-256 fingerprint');
    const stepContext = integer(raw.stepContext, 'stepContext', { min: 1, max: 2_000_000 });
    const budgetSource = String(raw.budgetSource || '');
    if (!BUDGET_SOURCES.includes(budgetSource)) fail('budgetSource is not supported');
    if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 32) fail('steps must contain between 1 and 32 entries');
    const steps = raw.steps.map(normalizeStep);
    if (new Set(steps.map(step => step.id)).size !== steps.length) fail('step ids must be unique');

    const countsRaw = object(raw.counts, 'counts');
    const counts = Object.fromEntries(STATES.map(state => [state, integer(countsRaw[state], `counts.${state}`, { max: 32 })]));
    for (const state of STATES) {
      if (counts[state] !== steps.filter(step => step.state === state).length) fail(`counts.${state} does not match steps`);
    }

    const running = steps.filter(step => step.state === 'running');
    if (running.length > 1) fail('only one step may be running');
    let currentStep = null;
    if (raw.currentStep != null && raw.currentStep !== '') currentStep = identifier(raw.currentStep, 'currentStep');
    if ((running.length === 1 && currentStep !== running[0].id) || (running.length === 0 && currentStep != null)) {
      fail('currentStep must identify the running step');
    }

    return { schema: SCHEMA, planFingerprint, stepContext, budgetSource, currentStep, counts, steps };
  }

  return { SCHEMA, STATES, TEST_OUTCOMES, BUDGET_SOURCES, normalize };
});
