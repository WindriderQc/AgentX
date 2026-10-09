'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, mock } = require('node:test');

// Observe actual profile I/O without replacing it with a successful fake read.
// The adapter captures readFile on import; restore the shared API immediately.
const originalReadFile = fsPromises.readFile;
const observedReadFile = mock.fn(originalReadFile);
let execute;
try {
  fsPromises.readFile = observedReadFile;
  ({ execute } = require('../executors/openclaw-executor'));
} finally {
  fsPromises.readFile = originalReadFile;
}

const refusal = 'OPENCLAW_NATIVE_AGENT_BUDGET_UNQUALIFIED';
const runtimeVersion = 'admission-fixture-runtime';

function invocation(tier) {
  return {
    target: {
      mode: 'native_agent', tier, provider: 'ollama', model: 'fixture-model',
      harness: { version: runtimeVersion },
      nativePolicy: { maxTurns: 2, maxToolCalls: 1 },
    },
    envelope: {
      executionProfile: 'native-ceiling',
      budgets: {
        maxDurationMs: 1000, maxTokens: 64, maxCostNanodollars: 0,
        maxTurns: 2, maxToolCalls: 1,
      },
    },
    parameters: { timeoutMs: 1000, maxTokens: 32, thinking: false },
    input: { prompt: 'A bounded native agent benchmark cell.' },
  };
}

const variants = [
  { name: 'two turns and one tool call', prepare() {} },
  {
    name: 'an exhausted budget',
    prepare(input) {
      input.envelope.budgets.maxTurns = 0;
      input.envelope.budgets.maxToolCalls = 0;
      input.envelope.budgets.maxTokens = 0;
    },
  },
  {
    name: 'a caller-forged qualification boolean',
    prepare(input) {
      input.nativeBudgetQualified = true;
      input.target.nativeBudgetQualified = true;
    },
  },
];

for (const tier of ['local', 'free_cloud', 'paid_cloud']) {
  for (const variant of variants) {
    test(`native agent ${tier} refuses ${variant.name} before profile I/O or spawn`, async (t) => {
      const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-native-admission-'));
      const previousCwd = process.cwd();
      const previousRuntimeVersion = process.env.OPENCLAW_RUNTIME_VERSION;
      const input = invocation(tier);
      variant.prepare(input);
      let runCalls = 0;
      let rejection;
      const readCallsBefore = observedReadFile.mock.callCount();
      try {
        process.env.OPENCLAW_RUNTIME_VERSION = runtimeVersion;
        process.chdir(temporaryRoot);
        try {
          await execute(input, {
            config: path.join(temporaryRoot, 'unavailable-profile.json'),
            openclaw: path.join(temporaryRoot, 'unavailable-openclaw'),
          }, () => {
            runCalls += 1;
            throw new Error('Native process invocation was reached');
          });
        } catch (error) {
          rejection = error;
        }

        const profileReadCalls = observedReadFile.mock.callCount() - readCallsBefore;
        const entries = fs.readdirSync(temporaryRoot);
        t.diagnostic(`profileReadCalls=${profileReadCalls}; runCalls=${runCalls}; filesystemEntries=${entries.length}; rejection=${rejection?.message || 'none'}`);
        // Check effects before the refusal assertion so a wrong error cannot
        // hide filesystem writes or a reached native process boundary.
        assert.equal(runCalls, 0, 'admission must not invoke the native process');
        assert.deepEqual(entries, [], 'admission must not create work or invocation files');
        assert.ok(rejection, 'unqualified native execution must reject');
        assert.equal(rejection.message, refusal);
        assert.equal(profileReadCalls, 0, 'admission must precede reading the pinned profile');
      } finally {
        process.chdir(previousCwd);
        if (previousRuntimeVersion === undefined) delete process.env.OPENCLAW_RUNTIME_VERSION;
        else process.env.OPENCLAW_RUNTIME_VERSION = previousRuntimeVersion;
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      }
    });
  }
}
