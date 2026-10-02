import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const TOOL_NAME = "dsh_coding_agent";
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const defaults = {
  wrapperPath: fileURLToPath(new URL("../../../coding/dsh-headless.sh", import.meta.url)),
  receiptRoot: path.join(os.homedir(), "dsh-workspaces/.agentx/receipts"),
  auditLog: path.join(os.homedir(), ".openclaw/logs/dsh-coding-agent.jsonl"),
  maxOutputBytes: 262144,
  timeoutBufferMs: 45000,
};

function settings(config = {}) {
  return { ...defaults, ...config };
}

export function validateParams(params = {}) {
  if (!WORKSPACE_PATTERN.test(String(params.workspaceName || ""))) {
    throw new Error("workspaceName must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  }
  if (typeof params.task !== "string" || !params.task.trim() || params.task.length > 20000) {
    throw new Error("task must contain 1..20000 characters");
  }
  if (params.confirmedNoSecrets !== true) {
    throw new Error("confirmedNoSecrets must be true; secret-bearing work is forbidden");
  }
  const timeoutSeconds = params.timeoutSeconds ?? 1200;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1200) {
    throw new Error("timeoutSeconds must be an integer from 1 to 1200");
  }
  return {
    workspaceName: params.workspaceName,
    task: params.task,
    confirmedNoSecrets: true,
    reuse: params.reuse === true,
    timeoutSeconds,
  };
}

export function buildArgs(params) {
  const validated = validateParams(params);
  return [
    ...(validated.reuse ? ["--reuse"] : []),
    "--timeout-seconds", String(validated.timeoutSeconds),
    validated.workspaceName,
    validated.task,
  ];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function audit(config, record) {
  await mkdir(path.dirname(config.auditLog), { recursive: true, mode: 0o700 });
  await appendFile(config.auditLog, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
}

async function loadReceipt(stderr, config) {
  const matches = [...stderr.matchAll(/^dsh-receipt: (.+)$/gm)];
  if (!matches.length) return null;
  const root = await realpath(config.receiptRoot);
  const candidate = await realpath(matches.at(-1)[1].trim());
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("wrapper returned a receipt outside the configured receipt root");
  }
  const receipt = JSON.parse(await readFile(candidate, "utf8"));
  if (receipt?.schema !== 1 || typeof receipt?.task_sha256 !== "string") {
    throw new Error("wrapper returned an invalid schema-1 receipt");
  }
  return { path: candidate, ...receipt };
}

export async function runDsh(rawParams, rawConfig = {}, spawnImpl = spawn) {
  const params = validateParams(rawParams);
  const config = settings(rawConfig);
  const args = buildArgs(params);
  const started = Date.now();

  const outcome = await new Promise((resolve, reject) => {
    const child = spawnImpl(config.wrapperPath, args, {
      cwd: os.homedir(),
      env: {
        HOME: os.homedir(),
        USER: os.userInfo().username,
        LOGNAME: os.userInfo().username,
        DSH_MODEL: config.model || process.env.DSH_MODEL || "",
        DSH_AGENTX_CLAIM_HOST: config.claimHost || process.env.DSH_AGENTX_CLAIM_HOST || "",
        AGENTX_CORE_URL: config.coreUrl || process.env.AGENTX_CORE_URL || "http://127.0.0.1:3180",
        AGENTX_MODEL_LIFECYCLE_LOCK_FILE: config.lockFile || process.env.AGENTX_MODEL_LIFECYCLE_LOCK_FILE || "",
        AGENTX_NODE_BIN: config.nodePath || process.env.AGENTX_NODE_BIN || "/usr/local/bin/node",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let overflow = false;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > config.maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      params.timeoutSeconds * 1000 + config.timeoutBufferMs,
    );
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error("DSH output exceeded the configured limit"));
      resolve({
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });

  const receipt = await loadReceipt(outcome.stderr, config);
  if (outcome.exitCode === 0 && !receipt) {
    throw new Error("successful DSH run did not return a receipt");
  }
  if (receipt && receipt.task_sha256 !== sha256(params.task)) {
    throw new Error("DSH receipt task hash does not match the delegated task");
  }
  const value = {
    ok: outcome.exitCode === 0,
    workspaceName: params.workspaceName,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    durationMs: Date.now() - started,
    report: outcome.stdout,
    receipt,
    diagnostics: outcome.stderr.replace(/^dsh-receipt: .+$/gm, "").trim(),
  };
  await audit(config, {
    tool: TOOL_NAME,
    workspaceName: params.workspaceName,
    taskSha256: sha256(params.task),
    reuse: params.reuse,
    timeoutSeconds: params.timeoutSeconds,
    exitCode: outcome.exitCode,
    receiptPath: receipt?.path || null,
    status: value.ok ? "ok" : "error",
  });
  return value;
}

export function createPlugin(defineToolPlugin) { return defineToolPlugin({
  id: "dsh-coding-agent",
  name: "DSH Coding Agent",
  description: "A single bounded OpenClaw tool for the isolated local DSH coding lane.",
  configSchema: Type.Object({
    wrapperPath: Type.Optional(Type.String()),
    receiptRoot: Type.Optional(Type.String()),
    auditLog: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    claimHost: Type.Optional(Type.String()),
    coreUrl: Type.Optional(Type.String()),
    lockFile: Type.Optional(Type.String()),
    nodePath: Type.Optional(Type.String()),
    maxOutputBytes: Type.Optional(Type.Integer({ minimum: 4096, maximum: 1048576 })),
    timeoutBufferMs: Type.Optional(Type.Integer({ minimum: 5000, maximum: 120000 })),
  }, { additionalProperties: false }),
  tools: (tool) => [
    tool({
      name: TOOL_NAME,
      description: "Delegate non-secret, non-production code or file work to the local DSH agent in one isolated workspace. This is the only DSH execution door; it cannot accept pipeline work, commit, push, merge, deploy, or access the host home. Set confirmedNoSecrets only after checking the staged inputs.",
      parameters: Type.Object({
        workspaceName: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", minLength: 1, maxLength: 64 }),
        task: Type.String({ minLength: 1, maxLength: 20000 }),
        confirmedNoSecrets: Type.Literal(true),
        reuse: Type.Optional(Type.Boolean()),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1200 })),
      }, { additionalProperties: false }),
      optional: true,
      async execute(params, config) {
        return runDsh(params, config);
      },
    }),
  ],
}); }
