'use strict';

const { isDeepStrictEqual } = require('node:util');
const { buildCoverage } = require('./coverageState');
const { loadCatalogPrompts } = require('../benchmark/promptComparison');
const { executionConfigFor } = require('./coverageLauncher');
const { hostKey, modelKey } = require('./coverageScope');
const { SCORER_VERSION } = require('../scoring/scorerVersion');

function refused(message) {
  return Object.assign(new Error(message), { code: 'COVERAGE_INTENT_CHANGED', statusCode: 409, notStarted: true });
}

async function promptVersions(ids, load = loadCatalogPrompts) {
  const catalog = await load();
  const selected = [...catalog].filter(([, prompt]) => ids.includes(prompt.id))
    .map(([fingerprint, prompt]) => [prompt.id, fingerprint]).sort((a, b) => a[0].localeCompare(b[0]));
  if (selected.length !== ids.length) throw refused('Selected coverage prompts no longer match the catalog');
  return selected;
}

async function validateIntent(intent, deps = {}) {
  const coverage = await (deps.buildCoverage || buildCoverage)();
  const current = coverage.cells.find(cell => hostKey(cell.hostUrl) === hostKey(intent.cell.hostUrl)
    && modelKey(cell.model) === modelKey(intent.cell.model));
  if (!current || current.hostId !== intent.cell.hostId || current.next !== intent.kind
    || !isDeepStrictEqual(current.artifact, intent.cell.artifact)
    || current.pinContext !== intent.cell.pinContext || current.residency !== intent.cell.residency
    || intent.scorerVersion !== SCORER_VERSION) throw refused('Coverage scope, artifact, scorer or host configuration changed');
  if (intent.kind === 'benchmark') {
    const ids = intent.body.prompt_ids;
    if (!ids.every(id => current.missingPromptIds.includes(id))
      || !isDeepStrictEqual(await promptVersions(ids, deps.loadCatalogPrompts), intent.promptVersions)
      || !isDeepStrictEqual(await executionConfigFor(current, deps), intent.body.execution_config)) {
      throw refused('Coverage prompt versions, missing cells or execution configuration changed');
    }
    const judge = await (deps.resolveJudge || require('../benchmark/judgeReadiness').resolveReadyJudgeTarget)(intent.body.judge_config);
    if (!judge.ready || hostKey(judge.target.host) !== hostKey(intent.body.judge_config.host)
      || modelKey(judge.target.model) !== modelKey(intent.body.judge_config.model)) throw refused('The original coverage judge is not ready');
    const frozen = await (deps.freezeJudgeConfig || require('../benchmark/judgeExecutionContract').freezeJudgeConfig)(intent.body.judge_config);
    if (!isDeepStrictEqual(frozen, intent.body.judge_config)) throw refused('The original judge artifact, runtime or context changed');
  }
  return current;
}

async function assertFrozenBatch(id, judgeConfig, selectedPrompts, deps = {}) {
  const attempt = await (deps.attempts || require('./coverageAttempts')).get(id);
  const fingerprint = deps.fingerprint || require('../../../../shared/benchmarkTargetContract').buildPromptFingerprint;
  const versions = selectedPrompts.map(prompt => [String(prompt._id), fingerprint(prompt)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (!attempt?.nativeDispatchedAt || !isDeepStrictEqual(versions, attempt.intent.promptVersions)
    || !isDeepStrictEqual(judgeConfig.execution_contract, attempt.intent.body.judge_config.execution_contract)) {
    // Admission is already held at this point. Let its existing owner release
    // it, and keep any lost hand-off/result unknown rather than infer release.
    throw Object.assign(new Error('Coverage judge or prompt proof changed during native preparation'), { code: 'COVERAGE_PROOF_CHANGED' });
  }
}

module.exports = { promptVersions, validateIntent, refused, assertFrozenBatch };
