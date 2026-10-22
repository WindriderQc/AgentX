// Bounded public projection of Core's multi-host code-step graph. Private
// manifests, commands, output, SSH targets, admissions and worktree paths are
// deliberately absent. Both Core and the browser normalize this whitelist.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const api = factory();
    api.mountBrowser = app => app.get('/js/code-step-graph-summary.js', (_req, res) => res.sendFile(__filename));
    module.exports = api;
  } else root.AgentXCodeStepGraphSummary = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  const SCHEMA = 'agentx.code-step-graph-summary/v1';
  const GRAPH_STATES = ['planning', 'running', 'assembling', 'verifying', 'publishing', 'published', 'failed', 'blocked', 'stopped'];
  const STEP_STATES = ['pending', 'waiting', 'running', 'passed', 'failed', 'uncertain', 'blocked'];
  const ACTIVE_STATES = new Set(['running', 'uncertain']);
  const TEST_OUTCOMES = ['passed', 'failed', 'unknown'];
  const ASSEMBLY_STATES = ['pending', 'assembling', 'verifying', 'publishing', 'published', 'failed', 'blocked'];
  const ADOPTION_STATES = ['pending', 'adopted', 'conflict'];
  const PUBLICATION_STATES = ['pending', 'publishing', 'published', 'unknown', 'failed'];
  const BUDGET_FIELDS = ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls', 'ciSeconds'];
  const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
  const EXECUTOR_ID = /^[a-z][a-z0-9_-]{0,63}$/;
  const HARNESS = /^[a-z][a-z0-9._-]{0,63}$/;
  const SHA40 = /^[a-f0-9]{40}$/;
  const SHA256 = /^[a-f0-9]{64}$/;

  function fail(message) { throw new Error(`Invalid code-step graph summary: ${message}`); }
  function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
    return value;
  }
  function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer from ${min} through ${max}`);
    return value;
  }
  function identifier(value, name, max = 120) {
    const text = String(value ?? '').trim();
    if (!text || text.length > max || !IDENTIFIER.test(text)) fail(`${name} must be a bounded identifier`);
    return text;
  }
  function line(value, name, max) {
    if (typeof value !== 'string') fail(`${name} must be text`);
    const text = value.trim();
    if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) fail(`${name} must be one bounded display line`);
    return text;
  }
  function enumeration(value, values, name) {
    const text = String(value || '');
    if (!values.includes(text)) fail(`${name} is not supported`);
    return text;
  }
  function sha(value, pattern, name) {
    const text = String(value || '').trim().toLowerCase();
    if (!pattern.test(text)) fail(`${name} is invalid`);
    return text;
  }
  function optionalSha(value, pattern, name) {
    return value == null || value === '' ? null : sha(value, pattern, name);
  }

  function normalizeExecutor(value, name) {
    const raw = object(value, name);
    const id = String(raw.id || '').trim();
    const harness = String(raw.harness || '').trim();
    if (!EXECUTOR_ID.test(id)) fail(`${name}.id is invalid`);
    if (!HARNESS.test(harness)) fail(`${name}.harness is invalid`);
    return { id, label: line(raw.label, `${name}.label`, 64), harness };
  }

  function normalizeTest(value, name) {
    const raw = object(value, name);
    const result = { profile: identifier(raw.profile, `${name}.profile`),
      outcome: enumeration(raw.outcome, TEST_OUTCOMES, `${name}.outcome`) };
    if (raw.durationMs != null) result.durationMs = integer(raw.durationMs, `${name}.durationMs`, { max: 604_800_000 });
    return result;
  }

  function normalizeAdoption(value, name) {
    const raw = object(value, name);
    const state = enumeration(raw.state, ADOPTION_STATES, `${name}.state`);
    const assemblyCommit = optionalSha(raw.assemblyCommit, SHA40, `${name}.assemblyCommit`);
    const receiptFingerprint = optionalSha(raw.receiptFingerprint, SHA256, `${name}.receiptFingerprint`);
    if (state === 'adopted' && (!assemblyCommit || !receiptFingerprint)) fail(`${name} adopted state requires its commit and receipt`);
    if (state === 'conflict' && (!receiptFingerprint || assemblyCommit)) fail(`${name} conflict state requires only its receipt`);
    if (state === 'pending' && (assemblyCommit || receiptFingerprint)) fail(`${name} pending state cannot claim an adoption receipt`);
    return { state, ...(assemblyCommit && { assemblyCommit }), ...(receiptFingerprint && { receiptFingerprint }) };
  }

  function normalizeStep(value, index, earlierIds) {
    const name = `steps[${index}]`;
    const raw = object(value, name);
    const id = identifier(raw.id, `${name}.id`, 80);
    const state = enumeration(raw.state, STEP_STATES, `${name}.state`);
    if (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > 31) fail(`${name}.dependsOn must be a bounded list`);
    const dependsOn = raw.dependsOn.map((dependency, dependencyIndex) => identifier(
      dependency, `${name}.dependsOn[${dependencyIndex}]`, 80));
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.some(dependency => !earlierIds.has(dependency))) {
      fail(`${name}.dependsOn must contain distinct earlier step ids`);
    }
    if (!Array.isArray(raw.tests) || raw.tests.length > 16) fail(`${name}.tests must contain at most 16 focused test results`);
    const tests = raw.tests.map((test, testIndex) => normalizeTest(test, `${name}.tests[${testIndex}]`));
    const attempt = integer(raw.attempt, `${name}.attempt`, { max: 5 });
    const executor = raw.executor == null ? null : normalizeExecutor(raw.executor, `${name}.executor`);
    if (attempt > 0 && !executor) fail(`${name} attempted state requires its selected executor`);
    const commit = optionalSha(raw.commit, SHA40, `${name}.commit`);
    if (state === 'passed' && (!commit || !tests.length || tests.some(test => test.outcome !== 'passed'))) {
      fail(`${name} passed state requires one commit and passing focused tests`);
    }
    if (state !== 'passed' && commit) fail(`${name} may retain a commit only after passing focused tests`);
    if (['running', 'passed', 'failed', 'uncertain', 'blocked'].includes(state) && attempt < 1) {
      fail(`${name}.${state} requires an attempt`);
    }
    const waitCode = raw.waitCode == null || raw.waitCode === '' ? null : identifier(raw.waitCode, `${name}.waitCode`);
    const failureCode = raw.failureCode == null || raw.failureCode === '' ? null : identifier(raw.failureCode, `${name}.failureCode`);
    if (['waiting', 'uncertain'].includes(state) && !waitCode) fail(`${name}.${state} requires a wait code`);
    if (['failed', 'blocked'].includes(state) && !failureCode) fail(`${name}.${state} requires a failure code`);
    const adoption = raw.adoption == null ? null : normalizeAdoption(raw.adoption, `${name}.adoption`);
    if (adoption && state !== 'passed') fail(`${name} may have adoption evidence only after passing`);
    return { id, title: line(raw.title, `${name}.title`, 160), state, dependsOn, attempt,
      ...(executor && { executor }), ...(commit && { commit }), tests,
      ...(waitCode && { waitCode }), ...(failureCode && { failureCode }), ...(adoption && { adoption }) };
  }

  function normalizeBudget(value, name) {
    const raw = object(value, name);
    return Object.fromEntries(BUDGET_FIELDS.map(field => [field, integer(raw[field], `${name}.${field}`, {
      max: field === 'modelCalls' ? 10000 : 604_800,
    })]));
  }

  function normalizeVerification(value, name) {
    const raw = object(value, name);
    const result = { profile: identifier(raw.profile, `${name}.profile`),
      outcome: enumeration(raw.outcome, TEST_OUTCOMES, `${name}.outcome`) };
    if (raw.durationMs != null) result.durationMs = integer(raw.durationMs, `${name}.durationMs`, { max: 604_800_000 });
    return result;
  }

  function normalizePublication(value, name) {
    const raw = object(value, name);
    const state = enumeration(raw.state, PUBLICATION_STATES, `${name}.state`);
    const headCommit = optionalSha(raw.headCommit, SHA40, `${name}.headCommit`);
    let prNumber = null, url = null;
    if (raw.prNumber != null) prNumber = integer(raw.prNumber, `${name}.prNumber`, { min: 1, max: 100_000_000 });
    if (raw.url != null && raw.url !== '') {
      try {
        const parsed = new URL(String(raw.url));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !/\/pull\/\d+\/?$/.test(parsed.pathname)) throw new Error();
        url = parsed.toString();
      } catch { fail(`${name}.url must identify an HTTPS pull request`); }
    }
    if (state === 'published' && (!headCommit || !prNumber || !url)) fail(`${name} published state requires its head and pull request`);
    if (state !== 'published' && (headCommit || prNumber || url)) fail(`${name} may expose pull-request identity only after publication`);
    return { state, ...(headCommit && { headCommit }), ...(prNumber && { prNumber }), ...(url && { url }) };
  }

  function normalizeAssembly(value, adoptedCount, stepCount) {
    const raw = object(value, 'assembly');
    const state = enumeration(raw.state, ASSEMBLY_STATES, 'assembly.state');
    const executor = raw.executor == null ? null : normalizeExecutor(raw.executor, 'assembly.executor');
    if (state !== 'pending' && !executor) fail('assembly execution requires its selected executor');
    const baseCommit = optionalSha(raw.baseCommit, SHA40, 'assembly.baseCommit');
    const headCommit = optionalSha(raw.headCommit, SHA40, 'assembly.headCommit');
    const adoptedSteps = integer(raw.adoptedSteps, 'assembly.adoptedSteps', { max: stepCount });
    if (adoptedSteps !== adoptedCount) fail('assembly.adoptedSteps does not match step adoption receipts');
    const verification = raw.verification == null ? null : normalizeVerification(raw.verification, 'assembly.verification');
    const publication = raw.publication == null ? null : normalizePublication(raw.publication, 'assembly.publication');
    const receiptFingerprint = optionalSha(raw.receiptFingerprint, SHA256, 'assembly.receiptFingerprint');
    if (['publishing', 'published'].includes(state) && verification?.outcome !== 'passed') {
      fail('assembly publication requires passing final verification');
    }
    if (state === 'published' && (!baseCommit || !headCommit || publication?.state !== 'published'
      || publication.headCommit !== headCommit || !receiptFingerprint)) {
      fail('published assembly requires matching final verification, publication, and receipt evidence');
    }
    if (['failed', 'blocked'].includes(state) && !receiptFingerprint) fail('terminal assembly failure requires its receipt');
    return { state, ...(executor && { executor }), ...(baseCommit && { baseCommit }), ...(headCommit && { headCommit }),
      adoptedSteps, ...(verification && { verification }), ...(publication && { publication }),
      ...(receiptFingerprint && { receiptFingerprint }) };
  }

  function normalize(value) {
    const raw = object(value, 'codeStepGraph');
    if (raw.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
    const graphId = identifier(raw.graphId, 'graphId');
    const planFingerprint = sha(raw.planFingerprint, SHA256, 'planFingerprint');
    const state = enumeration(raw.state, GRAPH_STATES, 'state');
    if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 32) fail('steps must contain between 1 and 32 entries');
    const earlierIds = new Set();
    const steps = raw.steps.map((step, index) => {
      const normalized = normalizeStep(step, index, earlierIds);
      if (earlierIds.has(normalized.id)) fail('step ids must be unique');
      earlierIds.add(normalized.id);
      return normalized;
    });
    if (!Array.isArray(raw.activeSteps) || raw.activeSteps.length > steps.length) fail('activeSteps must be a bounded list');
    const activeSteps = raw.activeSteps.map((step, index) => identifier(step, `activeSteps[${index}]`, 80));
    const expectedActive = steps.filter(step => ACTIVE_STATES.has(step.state)).map(step => step.id);
    if (JSON.stringify(activeSteps) !== JSON.stringify(expectedActive)) fail('activeSteps must list running and uncertain steps in graph order');

    const countsRaw = object(raw.counts, 'counts');
    const counts = Object.fromEntries(STEP_STATES.map(stepState => [stepState,
      integer(countsRaw[stepState], `counts.${stepState}`, { max: 32 })]));
    for (const stepState of STEP_STATES) {
      if (counts[stepState] !== steps.filter(step => step.state === stepState).length) fail(`counts.${stepState} does not match steps`);
    }
    const budgetRaw = object(raw.budget, 'budget');
    const budget = { reserved: normalizeBudget(budgetRaw.reserved, 'budget.reserved'),
      spent: normalizeBudget(budgetRaw.spent, 'budget.spent') };
    const adoptedCount = steps.filter(step => step.adoption?.state === 'adopted').length;
    const assembly = normalizeAssembly(raw.assembly, adoptedCount, steps.length);
    if (state === 'published' && (steps.some(step => step.state !== 'passed')
      || adoptedCount !== steps.length || assembly.state !== 'published')) {
      fail('published graph requires every step and final assembly receipt');
    }
    return { schema: SCHEMA, graphId, planFingerprint, state, activeSteps, counts, budget, steps, assembly };
  }

  return { SCHEMA, GRAPH_STATES, STEP_STATES, TEST_OUTCOMES, ASSEMBLY_STATES, ADOPTION_STATES,
    PUBLICATION_STATES, BUDGET_FIELDS, normalize };
});
