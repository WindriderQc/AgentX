'use strict';

const {
  SOURCE_PLAN_SCHEMA,
  PLAN_SCHEMA,
  canonicalStringify,
  pathsOverlap,
  validatePlan,
} = require('../../../shared/codeStepDagContract');

function plan(overrides = {}) {
  return {
    schema: SOURCE_PLAN_SCHEMA,
    summary: 'Implement the reviewed change',
    steps: [
      {
        id: 'step-01', title: 'Shared base', objective: 'Change the shared directory',
        paths: ['src/lib'], testTargets: ['test:base'], dependsOn: [],
      },
      {
        id: 'step-02', title: 'Nested change', objective: 'Change a nested file',
        paths: ['src/lib/a.js'], testTargets: ['test:nested'], dependsOn: [],
      },
      {
        id: 'step-03', title: 'Independent change', objective: 'Change another file',
        paths: ['src/other.js'], testTargets: ['test:other'], dependsOn: [],
      },
    ],
    ...overrides,
  };
}

const options = {
  reviewedScope: ['src/other.js', 'src/lib/a.js', 'src/lib'],
  reviewedLockKeys: ['file:src/other.js', 'file:src/lib', 'file:src/lib/a.js'],
};

test('canonicalizes and fingerprints the reviewed v1 plan deterministically', () => {
  const first = validatePlan(plan(), options);
  const second = validatePlan(plan(), {
    reviewedScope: [...options.reviewedScope].reverse(),
    reviewedLockKeys: [...options.reviewedLockKeys].reverse(),
  });

  expect(first.plan.schema).toBe(PLAN_SCHEMA);
  expect(first.plan.sourceSchema).toBe(SOURCE_PLAN_SCHEMA);
  expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(second).toEqual(first);
  expect(canonicalStringify({ z: 1, a: { d: 2, b: 1 } }))
    .toBe('{"a":{"b":1,"d":2},"z":1}');
});

test('derives effective dependencies from declared dependencies and overlapping paths or locks', () => {
  const derived = validatePlan(plan({
    steps: [
      plan().steps[0],
      plan().steps[1],
      { ...plan().steps[2], dependsOn: ['step-01'] },
    ],
  }), options).plan.steps;

  expect(derived[1].effectiveDependsOn).toEqual(['step-01']);
  expect(derived[2].effectiveDependsOn).toEqual(['step-01']);
  expect(derived[0].lockKeys).toEqual(['file:src/lib', 'file:src/lib/a.js']);
  expect(pathsOverlap('src/lib', 'src/lib/a.js')).toBe(true);
  expect(pathsOverlap('src/lib', 'src/other.js')).toBe(false);

  const globallyLocked = validatePlan(plan(), {
    ...options,
    reviewedLockKeys: [...options.reviewedLockKeys, 'repo:shared-index'],
  }).plan.steps;
  expect(globallyLocked[2].effectiveDependsOn).toEqual(['step-01', 'step-02']);
});

test('rejects plans that escape scope, reorder ids, or depend on later steps', () => {
  const outside = plan({
    steps: [{ ...plan().steps[0], paths: ['src/unreviewed.js'] }, ...plan().steps.slice(1)],
  });
  expect(() => validatePlan(outside, options)).toThrow(expect.objectContaining({ code: 'PATH_OUTSIDE_SCOPE' }));

  const wrongId = plan({ steps: [{ ...plan().steps[0], id: 'step-02' }, ...plan().steps.slice(1)] });
  expect(() => validatePlan(wrongId, options)).toThrow(expect.objectContaining({ code: 'INVALID_STEP_ID' }));

  const futureDependency = plan({
    steps: [{ ...plan().steps[0], dependsOn: ['step-02'] }, ...plan().steps.slice(1)],
  });
  expect(() => validatePlan(futureDependency, options))
    .toThrow(expect.objectContaining({ code: 'INVALID_DEPENDENCIES' }));
});

test('the fingerprint changes for a reviewed semantic change', () => {
  const original = validatePlan(plan(), options);
  const changed = validatePlan(plan({
    steps: [{ ...plan().steps[0], objective: 'A different reviewed objective' }, ...plan().steps.slice(1)],
  }), options);
  expect(changed.fingerprint).not.toBe(original.fingerprint);
});
