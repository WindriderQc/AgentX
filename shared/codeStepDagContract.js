'use strict';

const crypto = require('crypto');

const SOURCE_PLAN_SCHEMA = 'agentx.coding-code-plan/v1';
const PLAN_SCHEMA = 'agentx.pipeline-code-step-dag-plan/v1';
const DAG_SCHEMA = 'agentx.pipeline-code-step-dag/v1';
const MAX_STEPS = 16;
const MAX_PATHS_PER_STEP = 64;
const MAX_TEST_TARGETS_PER_STEP = 32;

class CodeStepDagContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodeStepDagContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CodeStepDagContractError(code, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail('INVALID_OBJECT', `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_KEYS', `${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function boundedString(value, label, maxLength = 512) {
  if (typeof value !== 'string') fail('INVALID_STRING', `${label} must be a string`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maxLength) {
    fail('INVALID_STRING', `${label} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function repositoryPath(value, label = 'path') {
  if (typeof value !== 'string') fail('INVALID_PATH', `${label} must be a string`);
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('//') ||
    normalized.split('/').some((part) => part === '.' || part === '..' || part === '') ||
    normalized.includes('\0') ||
    normalized.length > 512
  ) {
    fail('INVALID_PATH', `${label} must be a normalized repository-relative path`);
  }
  return normalized;
}

function uniqueSorted(values, normalize, label, maximum) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximum) {
    fail('INVALID_LIST', `${label} must contain 1-${maximum} entries`);
  }
  const normalized = values.map((value, index) => normalize(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_ENTRY', `${label} contains duplicates`);
  return normalized.sort();
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizeReviewedScope(reviewedScope) {
  return uniqueSorted(reviewedScope, repositoryPath, 'reviewedScope', 512);
}

function normalizeReviewedLockKeys(reviewedLockKeys = []) {
  if (!Array.isArray(reviewedLockKeys) || reviewedLockKeys.length > 256) {
    fail('INVALID_LOCKS', 'reviewedLockKeys must be an array with at most 256 entries');
  }
  const keys = reviewedLockKeys.map((value, index) => boundedString(value, `reviewedLockKeys[${index}]`, 256));
  if (new Set(keys).size !== keys.length) fail('DUPLICATE_ENTRY', 'reviewedLockKeys contains duplicates');
  return keys.sort();
}

function locksForPaths(paths, reviewedLockKeys, reviewedScopeSet) {
  const result = [];
  for (const key of reviewedLockKeys) {
    if (!key.startsWith('file:')) {
      result.push(key);
      continue;
    }
    const lockedPath = repositoryPath(key.slice(5), `lock ${key}`);
    if (!reviewedScopeSet.has(lockedPath)) {
      fail('LOCK_OUTSIDE_SCOPE', `file lock ${key} is outside reviewedScope`);
    }
    if (paths.some((path) => pathsOverlap(path, lockedPath))) result.push(key);
  }
  return result;
}

function validatePlan(rawPlan, options = {}) {
  assertExactKeys(rawPlan, ['schema', 'summary', 'steps'], 'plan');
  if (rawPlan.schema !== SOURCE_PLAN_SCHEMA) {
    fail('UNSUPPORTED_SCHEMA', `plan.schema must be ${SOURCE_PLAN_SCHEMA}`);
  }
  const reviewedScope = normalizeReviewedScope(options.reviewedScope);
  const reviewedScopeSet = new Set(reviewedScope);
  const reviewedLockKeys = normalizeReviewedLockKeys(options.reviewedLockKeys);
  if (!Array.isArray(rawPlan.steps) || rawPlan.steps.length === 0 || rawPlan.steps.length > MAX_STEPS) {
    fail('INVALID_STEPS', `plan.steps must contain 1-${MAX_STEPS} steps`);
  }

  const steps = rawPlan.steps.map((rawStep, index) => {
    assertExactKeys(rawStep, ['id', 'title', 'objective', 'paths', 'testTargets', 'dependsOn'], `steps[${index}]`);
    const expectedId = `step-${String(index + 1).padStart(2, '0')}`;
    if (rawStep.id !== expectedId) fail('INVALID_STEP_ID', `steps[${index}].id must be ${expectedId}`);
    const paths = uniqueSorted(rawStep.paths, repositoryPath, `steps[${index}].paths`, MAX_PATHS_PER_STEP);
    for (const path of paths) {
      if (!reviewedScopeSet.has(path)) fail('PATH_OUTSIDE_SCOPE', `${path} is outside reviewedScope`);
    }
    const testTargets = uniqueSorted(
      rawStep.testTargets,
      (value, label) => boundedString(value, label, 512),
      `steps[${index}].testTargets`,
      MAX_TEST_TARGETS_PER_STEP,
    );
    if (!Array.isArray(rawStep.dependsOn) || rawStep.dependsOn.length > index) {
      fail('INVALID_DEPENDENCIES', `steps[${index}].dependsOn must contain only earlier step ids`);
    }
    const previousIds = new Set(rawPlan.steps.slice(0, index).map((step) => step && step.id));
    const dependsOn = rawStep.dependsOn.map((value, dependencyIndex) =>
      boundedString(value, `steps[${index}].dependsOn[${dependencyIndex}]`, 32),
    );
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.some((id) => !previousIds.has(id))) {
      fail('INVALID_DEPENDENCIES', `steps[${index}].dependsOn must be unique earlier step ids`);
    }
    return {
      id: expectedId,
      title: boundedString(rawStep.title, `steps[${index}].title`, 160),
      objective: boundedString(rawStep.objective, `steps[${index}].objective`, 1000),
      paths,
      testTargets,
      dependsOn: dependsOn.sort(),
      lockKeys: locksForPaths(paths, reviewedLockKeys, reviewedScopeSet),
      effectiveDependsOn: [],
    };
  });

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const effective = new Set(step.dependsOn);
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
      const earlier = steps[earlierIndex];
      const pathConflict = step.paths.some((path) => earlier.paths.some((candidate) => pathsOverlap(path, candidate)));
      const lockConflict = step.lockKeys.some((key) => earlier.lockKeys.includes(key));
      if (pathConflict || lockConflict) effective.add(earlier.id);
    }
    step.effectiveDependsOn = [...effective].sort((left, right) => {
      const leftIndex = steps.findIndex((candidate) => candidate.id === left);
      const rightIndex = steps.findIndex((candidate) => candidate.id === right);
      return leftIndex - rightIndex;
    });
  }

  const plan = {
    schema: PLAN_SCHEMA,
    sourceSchema: SOURCE_PLAN_SCHEMA,
    summary: boundedString(rawPlan.summary, 'plan.summary', 1000),
    reviewedScope,
    reviewedLockKeys,
    steps,
  };
  return { plan, fingerprint: fingerprint(plan) };
}

module.exports = {
  SOURCE_PLAN_SCHEMA,
  PLAN_SCHEMA,
  DAG_SCHEMA,
  MAX_STEPS,
  CodeStepDagContractError,
  canonicalStringify,
  fingerprint,
  pathsOverlap,
  repositoryPath,
  validatePlan,
};
