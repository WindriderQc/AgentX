import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs, validateParams, runDsh, createPlugin } from "../lib/tools.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("buildArgs passes task as one argv value without a shell", () => {
  const args = buildArgs({
    workspaceName: "task-0565",
    task: "write $(touch /tmp/nope); then report",
    confirmedNoSecrets: true,
    timeoutSeconds: 30,
  });
  assert.deepEqual(args, ["--timeout-seconds", "30", "task-0565", "write $(touch /tmp/nope); then report"]);
});

test("reuse is explicit and bounded", () => {
  const args = buildArgs({
    workspaceName: "follow-up",
    task: "continue",
    confirmedNoSecrets: true,
    reuse: true,
  });
  assert.equal(args[0], "--reuse");
  assert.equal(args[2], "1200");
});

test("invalid workspace names and secrets assertion fail closed", () => {
  assert.throws(() => validateParams({ workspaceName: "../escape", task: "x", confirmedNoSecrets: true }), /workspaceName/);
  assert.throws(() => validateParams({ workspaceName: "safe", task: "x" }), /confirmedNoSecrets/);
  assert.throws(() => validateParams({ workspaceName: "safe", task: "x", confirmedNoSecrets: true, timeoutSeconds: 1201 }), /timeoutSeconds/);
});

test("native worker receives the explicit claim configuration without inheriting arbitrary secrets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentx-dsh-test-'));
  const previous = process.env.AGENTX_TEST_PRIVATE_SECRET;
  process.env.AGENTX_TEST_PRIVATE_SECRET = 'synthetic-must-not-inherit';
  try {
    const config = { model: 'synthetic-model', claimHost: 'http://synthetic.invalid:11434',
      coreUrl: 'http://127.0.0.1:3180', lockFile: '/private/shared.lock',
      auditLog: path.join(directory, 'audit.jsonl'), wrapperPath: '/configured/wrapper.sh' };
    const schema = createPlugin(value => value).configSchema;
    expectKeys(config, schema);
    let observed;
    const result = await runDsh({ workspaceName: 'synthetic', task: 'Synthetic test', confirmedNoSecrets: true }, config,
      (command, args, options) => {
        observed = { command, args, options };
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        queueMicrotask(() => child.emit('close', 1, null));
        return child;
      });
    assert.equal(result.ok, false);
    assert.equal(observed.command, config.wrapperPath);
    assert.equal(observed.options.shell, false);
    assert.equal(observed.options.env.DSH_AGENTX_CLAIM_HOST, config.claimHost);
    assert.equal(observed.options.env.DSH_MODEL, config.model);
    assert.equal(observed.options.env.AGENTX_MODEL_LIFECYCLE_LOCK_FILE, config.lockFile);
    assert.equal(observed.options.env.AGENTX_TEST_PRIVATE_SECRET, undefined);
  } finally {
    if (previous === undefined) delete process.env.AGENTX_TEST_PRIVATE_SECRET;
    else process.env.AGENTX_TEST_PRIVATE_SECRET = previous;
    await rm(directory, { recursive: true });
  }
});

function expectKeys(config, schema) {
  for (const key of Object.keys(config)) assert.ok(schema.properties[key], `configuration accepts ${key}`);
}
