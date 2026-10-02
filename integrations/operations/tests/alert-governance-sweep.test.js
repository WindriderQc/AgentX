'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SWEEP_PATH = path.resolve(__dirname, '..', 'alert-governance-sweep.js');

const {
  assessMemoryReviewEvidence,
  summarizeActivity,
  reportInferenceActivity,
  mongoActivityQuery,
  diffRules,
  driftCount,
  targetTaskAssignments,
  readConfig,
  parseArgs,
  queryActivity,
  validateConfig,
} = require('../alert-governance-sweep');

test('local Mongo query bypasses SSH and requires successful, complete evidence', () => {
  const options = parseArgs(['--local-mongo']);
  const detector = { windowHours: 24 };
  const evidence = { from: '2026-09-09T21:08:16.413Z', to: '2026-09-10T21:08:16.413Z', rows: [] };
  const run = (command, args, init) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args, ['exec', '-i', 'agentx-mongo-1', 'mongosh', '--quiet', 'agentx_product']);
    assert.match(init.input, /inferencelogs/);
    return { status: 0, stdout: 'mongosh banner\nRESULT_JSON=' + JSON.stringify(evidence) + '\n' };
  };
  assert.deepEqual(queryActivity(detector, options, new Date(), run), evidence);
  for (const result of [
    { status: 1, stdout: 'RESULT_JSON={}', stderr: 'Docker unavailable' },
    { status: 0, stdout: '' },
    { status: 0, stdout: 'RESULT_JSON={}' },
    { error: new Error('timed out') },
  ]) assert.throws(() => queryActivity(detector, options, new Date(), () => result));
});

function desired(ruleId = 'operator-rule') {
  return {
    ruleId,
    name: 'Operator rule',
    enabled: true,
    severity: 'warning',
    conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'example' }] },
    channels: ['local_log'],
    cooldownMs: 300000,
    renotifyMs: 3600000,
    description: 'Managed by AIOps.',
  };
}

test('diffRules ignores built-ins and reports missing, changed, and unexpected operator rules', () => {
  const rules = [desired('missing'), desired('changed')];
  const live = [
    { ...desired('changed'), builtIn: false, severity: 'info' },
    { ...desired('unexpected'), builtIn: false },
    { ...desired('product-built-in'), builtIn: true },
  ];
  const delta = diffRules(rules, live);
  assert.deepEqual(delta.missing.map((entry) => entry.ruleId), ['missing']);
  assert.deepEqual(delta.changed, [{ ruleId: 'changed', fields: ['severity'], desired: desired('changed') }]);
  assert.deepEqual(delta.unexpected, [{ ruleId: 'unexpected', enabled: true, severity: 'warning' }]);
  assert.equal(driftCount(delta), 3);
});

test('activity covers quiet hosts and separates benchmark, embedding and other requests', () => {
  const cluster = ['primary', 'secondary', 'tertiary'].map((hostKey) => ({ hostKey, hostUrl: `http://${hostKey}:11434`, status: 'online' }));
  const row = (hostKey, category, calls, errors = 0) => ({
    _id: { hostKey, host: `http://${hostKey}:11434`, category }, calls,
    successes: calls - errors, errors, durationMs: 1200, durationSamples: calls, lastAt: '2026-09-10T20:00:00.000Z'
  });
  const activity = { from: '2026-09-09T21:00:00.000Z', to: '2026-09-10T21:00:00.000Z', rows: [
    row('primary', 'benchmark', 72), row('primary', 'other', 128, 11),
    row('tertiary', 'benchmark', 998), row('tertiary', 'embedding', 78)
  ] };
  const report = summarizeActivity(cluster, activity, {});
  assert.equal(report.totals.calls, 1276);
  assert.equal(report.totals.benchmark, 1070);
  assert.equal(report.totals.embedding, 78);
  assert.equal(report.totals.other, 128);
  assert.equal(report.totals.errors, 11);
  assert.equal(report.hosts.length, 3);
  assert.equal(report.hosts[1].calls, 0);
  assert.equal(report.hosts[1].lastAt, null);
  assert.equal(report.hosts[1].assignment.authoritative, false);
  assert.equal(report.unattributed.calls, 0);
  assert.match(report.durationBasis, /not GPU busy time/);
  // A stale host key must not assign traffic from a different URL to this machine.
  activity.rows.push({ ...row('secondary', 'other', 1), _id: { hostKey: 'secondary', host: 'http://retired:11434', category: 'other' } });
  const changed = summarizeActivity(cluster, activity, {});
  assert.equal(changed.totals.calls, 1277);
  assert.equal(changed.hosts[1].calls, 0);
  assert.equal(changed.unattributed.calls, 1);
  assert.throws(() => summarizeActivity(cluster, { ...activity, rows: [{ ...row('primary', 'other', 1), calls: -1 }] }, {}), /Invalid activity/);
});

test('Mongo activity query retains exact bounds and attributes proxy benchmark callers', () => {
  const vm = require('node:vm');
  const now = new Date('2026-09-10T21:08:16.413Z');
  const query = mongoActivityQuery({ windowHours: 24 }, now);
  let pipeline;
  vm.runInNewContext(query.js, { db: { inferencelogs: { aggregate(value) { pipeline = value; return { toArray: () => [] }; } } }, print() {} });
  assert.equal(pipeline[0].$match.timestamp.$gte.toISOString(), '2026-09-09T21:08:16.413Z');
  assert.equal(pipeline[0].$match.timestamp.$lt.toISOString(), now.toISOString());
  const cases = pipeline[1].$group._id.category.$switch;
  const regex = new RegExp(cases.branches[0].case.$or[1].$regexMatch.regex);
  for (const caller of ['benchmark-decomposed-judge', 'benchmark-ref-keypoint', 'benchmark-batch-123', 'benchmark-warmup']) assert.ok(regex.test(caller));
  assert.equal(regex.test('openclaw-runtime-bridge'), false);
  assert.equal(cases.branches[1].then, 'embedding');
  assert.equal(cases.default, 'other');
});

test('activity report and legacy flag never evaluate alerts or change routing', async () => {
  assert.equal(parseArgs(['--evaluate-underuse']).reportInferenceActivity, true);
  const original = global.fetch;
  const methods = [];
  let cluster = [];
  global.fetch = async (url, options) => {
    methods.push(options.method);
    assert.equal(options.method, 'GET');
    return { ok: true, text: async () => JSON.stringify({ data: { cluster } }) };
  };
  try {
    await assert.rejects(reportInferenceActivity({ detectors: { inferenceActivity: { windowHours: 24 } } }, parseArgs([])), /missing configured hosts/);
    assert.deepEqual(methods, ['GET']);
    cluster = ['primary', 'secondary', 'tertiary'].map((hostKey) => ({ hostKey, hostUrl: `http://${hostKey}:11434`, status: 'online' }));
    const result = await reportInferenceActivity({ detectors: { inferenceActivity: { windowHours: 24 } } }, parseArgs([]), () => ({
      from: '2026-09-09T21:00:00Z', to: '2026-09-10T21:00:00Z', rows: []
    }));
    assert.deepEqual(methods, ['GET', 'GET', 'GET']);
    assert.equal(result.hosts.length, 3);
    assert.ok(result.hosts.every((host) => host.calls === 0));
  } finally { global.fetch = original; }
});

test('targetTaskAssignments accepts only a complete effective router contract for the exact host', () => {
  const detector = { targetHostKey: 'secondary', targetHostUrl: 'http://secondary:11434' };
  const payload = {
    data: {
      hosts: { primary: 'http://primary:11434', secondary: 'http://secondary:11434' },
      taskConfigState: {
        general_chat: { effective: { model: 'large', host: 'primary' } },
        voice_persona_reader: { effective: { model: 'small', host: 'secondary' } },
        nestor_answer_light: { effective: { model: 'small', host: 'secondary' } },
      },
    },
  };
  assert.deepEqual(targetTaskAssignments(detector, payload), {
    authoritative: true,
    reason: 'effective-task-state',
    tasks: ['nestor_answer_light', 'voice_persona_reader'],
  });
  assert.equal(targetTaskAssignments(detector, {}).authoritative, false);
  assert.equal(targetTaskAssignments(detector, { data: { ...payload.data, hosts: { secondary: 'http://wrong:11434' } } }).authoritative, false);
  assert.equal(targetTaskAssignments(detector, { data: { ...payload.data, taskConfigState: {} } }).authoritative, false);
  assert.equal(targetTaskAssignments(detector, {
    data: {
      ...payload.data,
      taskConfigState: { ...payload.data.taskConfigState, broken: { effective: { host: 'secondary' } } },
    },
  }).authoritative, false);
});

test('validateConfig rejects built-in ownership and disabled rules without a reason', () => {
  const base = {
    schemaVersion: 1,
    authority: 'aiops-operator',
    managedRules: [desired()],
    detectors: { inferenceActivity: { windowHours: 24 } },
  };
  assert.equal(validateConfig(base), base);
  assert.throws(() => validateConfig({ ...base, managedRules: [{ ...desired(), builtIn: false }] }), /must not declare builtIn/);
  assert.throws(() => validateConfig({ ...base, managedRules: [{ ...desired(), enabled: false }] }), /requires a reason/);
});

const quietDetector = {
  enabled: true,
  displayName: 'Dreaming Review',
  source: 'aiops-alert-governance-sweep',
  windowRuns: 7,
  minimumRuns: 3,
  maximumEligible: 0,
  expectedEvidenceClasses: ['owner'],
};

function insights(runs, runtimes) {
  return { totals: { runs }, runtimes };
}

test('memory review: a green but empty loop triggers', () => {
  // 34 completed runs, errors: 0, and one eligible observation ever. Run status
  // reported healthy the whole time; only the eligible count tells the truth.
  const assessment = assessMemoryReviewEvidence(
    quietDetector,
    { totals: { runs: 7, ownerEvidence: 0, projectEventEvidence: 115 }, runtimes: [] },
  );
  assert.equal(assessment.triggered, true);
  assert.equal(assessment.decision, 'no-eligible-evidence');
  assert.deepEqual(assessment.quiet, [
    { evidenceClass: 'owner', eligible: 0, reason: 'no-eligible-evidence' },
  ]);
});

test('memory review: legacy runtime detectors still distinguish never reported from silent', () => {
  const legacy = { ...quietDetector, expectedEvidenceClasses: undefined, expectedEvidenceRuntimes: ['agentx'] };
  const never = assessMemoryReviewEvidence(
    legacy,
    insights(7, [{ runtime: 'agentx', eligible: 0, health: 'not_seen' }]),
  );
  assert.equal(never.quiet[0].reason, 'never-seen');

  const absent = assessMemoryReviewEvidence(
    legacy,
    insights(7, [{ runtime: 'claude-code', eligible: 0, health: 'healthy' }]),
  );
  assert.equal(absent.quiet[0].reason, 'not-reported');
});

test('memory review: owner evidence clears the alert while project events alone do not', () => {
  const assessment = assessMemoryReviewEvidence(
    quietDetector,
    { totals: { runs: 7, ownerEvidence: 4, projectEventEvidence: 115 }, runtimes: [] },
  );
  assert.equal(assessment.triggered, false);
  assert.equal(assessment.decision, 'healthy');
  assert.deepEqual(assessment.quiet, []);
});

test('memory review: too few runs is not evidence of silence', () => {
  const assessment = assessMemoryReviewEvidence(
    quietDetector,
    insights(2, [{ runtime: 'agentx', eligible: 0, health: 'healthy' }]),
  );
  assert.equal(assessment.triggered, false);
  assert.equal(assessment.decision, 'insufficient-run-sample');
});

test('memory review: a missing runtimes array does not crash or manufacture health', () => {
  const assessment = assessMemoryReviewEvidence(quietDetector, { totals: { runs: 7 } });
  assert.equal(assessment.triggered, true);
  assert.equal(assessment.quiet[0].reason, 'no-eligible-evidence');
});

test('memory review detector config is validated', () => {
  const base = () => ({
    schemaVersion: 1,
    authority: 'aiops-operator',
    managedRules: [desired('memory-review-fixture')],
    detectors: { inferenceActivity: { windowHours: 24 }, memoryReviewQuiet: { ...quietDetector } },
  });

  assert.doesNotThrow(() => validateConfig(base()));

  const noEvidence = base();
  noEvidence.detectors.memoryReviewQuiet.expectedEvidenceClasses = [];
  assert.throws(() => validateConfig(noEvidence), /expectedEvidenceClasses or expectedEvidenceRuntimes/);

  const badWindow = base();
  badWindow.detectors.memoryReviewQuiet.windowRuns = 0;
  assert.throws(() => validateConfig(badWindow), /windowRuns/);

  const disabled = base();
  disabled.detectors.memoryReviewQuiet = { enabled: false };
  assert.doesNotThrow(() => validateConfig(disabled));
});

test('the generic example is inactive and preserves renotification when configured', () => {
  const config = readConfig(
    require('node:path').resolve(__dirname, '..', 'alert-rules.example.json'),
  );
  const rule = config.managedRules.find(
    (entry) => entry.ruleId === 'operator-memory-review-no-eligible-evidence',
  );
  assert.ok(rule, 'the managed rule must ship in desired state');
  assert.equal(config.authority, 'agentx-operator');
  assert.equal(rule.enabled, false);
  assert.equal(config.detectors.memoryReviewQuiet.enabled, false);
  // Without renotify, dedup collapses a permanent condition into one notice.
  assert.ok(Number(rule.renotifyMs) > 0);
  assert.deepEqual(rule.channels, ['local_log']);
  assert.equal(
    rule.conditions.all[0].value,
    'memory_review_no_eligible_evidence',
  );
});

test('Mongo selection is explicit and shell metacharacters never reach SSH', () => {
  const options = parseArgs(['--ssh-target', 'operator@host', '--mongo-container', 'custom-mongo', '--mongo-database', 'custom_db']);
  const evidence = { from: '2026-09-09T00:00:00Z', to: '2026-09-10T00:00:00Z', rows: [] };
  queryActivity({ windowHours: 24 }, options, new Date(), (command, args) => {
    assert.equal(command, 'ssh');
    assert.equal(args.at(-1), 'docker exec -i custom-mongo mongosh --quiet custom_db');
    return { status: 0, stdout: 'RESULT_JSON=' + JSON.stringify(evidence) };
  });
  for (const key of ['sshTarget', 'mongoContainer', 'mongoDatabase']) {
    for (const value of ['bad;echo injected', '-option', '']) {
      assert.throws(() => queryActivity({ windowHours: 24 }, { ...options, [key]: value }, new Date(), () => {
        assert.fail('Invalid identifiers must not execute');
      }));
    }
  }
});
