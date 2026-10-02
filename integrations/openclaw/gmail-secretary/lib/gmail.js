import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Bounded gog command builders and the runner shared by every Secretary tool.

export function evidenceArgs(action, config = {}) {
  const resolved = settings(config);
  return [resolved.evidenceHelperPath, "--root", resolved.evidenceRoot, action];
}

function evidenceEnvironment(config) {
  const resolved = settings(config);
  return { ...process.env, GMAIL_SECRETARY_GOG: resolved.gogPath,
    GMAIL_SECRETARY_ACCOUNT: resolved.account, GMAIL_SECRETARY_KEYRING_FILE: resolved.keyringPasswordFile };
}

export function evidenceCommand(params, config = {}) {
  if (!["next", "record"].includes(params.action)) throw new Error("Use next or record");
  if (params.action === "record" && (!params.review || typeof params.review !== "object")) throw new Error("review is required");
  return { args: evidenceArgs(`native_${params.action}`, config),
    stdin: params.action === "record" ? JSON.stringify(params.review) : "" };
}

export async function runEvidence(params, config = {}) {
  const command = evidenceCommand(params, config);
  return new Promise((resolve, reject) => {
    const child = spawn("python3", command.args, { env: evidenceEnvironment(config), stdio: ["pipe", "pipe", "pipe"] });
    let output = "", failed = false;
    const fail = error => { if (!failed) { failed = true; child.kill(); reject(error); } };
    const timer = setTimeout(() => fail(new Error("Secretary evidence timed out; retry the same page")), 240000);
    child.stdout.on("data", data => {
      output += data.toString();
      if (Buffer.byteLength(output) > 200000) fail(new Error("Secretary evidence response too large"));
    });
    child.stderr.resume(); // Provider bodies and private paths never enter scheduler errors.
    child.on("error", error => { clearTimeout(timer); fail(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) return reject(new Error(`Secretary evidence failed (${code}); private archive retained`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid Secretary evidence response")); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(command.stdin);
  });
}

export const defaults = {
  gogPath: "gog",
  account: "auto",
  keyringPasswordFile: path.join(os.homedir(), ".config/gogcli/keyring-password"),
  timezone: "America/Toronto",
  attachmentRoot: path.join(os.homedir(), ".openclaw/workspace-main/outbox"),
  auditLog: path.join(os.homedir(), ".openclaw/logs/gmail-secretary.jsonl"),
  triageStateFile: path.join(os.homedir(), ".openclaw/state/gmail-oldest-backlog.json"),
  evidenceHelperPath: fileURLToPath(new URL("../../../secretary/secretary_evidence.py", import.meta.url)),
  evidenceRoot: path.join(os.homedir(), ".local/share/agentx/secretary-evidence"),
  coreUrl: "http://127.0.0.1:3180",
  timeoutMs: 30000,
  maxOutputBytes: 1000000,
};

export function settings(config = {}) {
  return { ...defaults, ...config };
}

export function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function optionalFlag(args, flag, value) {
  if (typeof value === "string" && value.trim()) args.push(`${flag}=${value.trim()}`);
}

export function recipientFlags(args, params) {
  for (const field of ["to", "cc", "bcc"]) {
    const values = params[field];
    if (Array.isArray(values) && values.length) args.push(`--${field}=${values.join(",")}`);
  }
}

export function bodyFlags(args, params) {
  if (typeof params.bodyHtml === "string" && params.bodyHtml) return { args: [...args, "--body-html-file=-"], stdin: params.bodyHtml };
  return { args: [...args, "--body-file=-"], stdin: required(params.body, "body") };
}

export async function assertSafeAttachments(paths, root) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const rootReal = await realpath(root);
  const safe = [];
  for (const candidate of paths) {
    const resolved = await realpath(candidate);
    if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`attachment must be inside ${root}`);
    }
    safe.push(resolved);
  }
  return safe;
}

export function addAttachments(args, paths) {
  for (const file of paths) args.push(`--attach=${file}`);
}

export function readBase(config, exactCommand) {
  return [
    "--readonly", "--gmail-no-send", "--no-input", "--json", "--results-only",
    "--wrap-untrusted", `--enable-commands-exact=${exactCommand}`,
    `--account=${config.account}`,
  ];
}

export function mutateBase(config, exactCommand, { maySend = false } = {}) {
  return [
    ...(!maySend ? ["--gmail-no-send"] : []), "--no-input", "--json", "--results-only",
    "--wrap-untrusted", `--enable-commands-exact=${exactCommand}`,
    `--account=${config.account}`,
  ];
}

export function buildSearchCommand(params, config = defaults) {
  const messages = params.scope !== "threads";
  const exact = messages ? "gmail.messages.search" : "gmail.search";
  const args = [...readBase(config, exact).filter(arg => arg !== "--results-only"), "gmail", ...(messages ? ["messages"] : []), "search", required(params.query, "query")];
  args.push(`--max=${Math.min(50, Math.max(1, params.max ?? 10))}`, `--timezone=${config.timezone}`);
  // Search enumerates metadata only. Bodies always use the same resumable reader;
  // a batch of quoted messages must never overflow or flood the model context.
  if (params.pageToken) args.push(`--page=${params.pageToken}`);
  return { args };
}

export function buildReadCommand(params, config = defaults) {
  const id = params.kind === "labels" ? "" : required(params.id, "id");
  if (params.kind === "thread" || (params.kind === "message" && params.format !== "metadata")) {
    return { program: "python3", timeoutMs: 125000,
      args: evidenceArgs("read_source", config),
      stdin: JSON.stringify({ kind: params.kind, id, offset: params.offset ?? 0,
        size: params.size ?? 10000, sourceHash: params.sourceHash }) };
  }
  const map = {
    message: ["gmail.get", ["gmail", "get", id, `--format=${params.format ?? "full"}`, ...(params.sanitizeContent ? ["--sanitize-content"] : [])]],
    thread: ["gmail.thread.get", [
      "gmail", "thread", "get", id,
      ...(params.full ? ["--full"] : []),
      ...(params.sanitizeContent ? ["--sanitize-content"] : []),
    ]],
    attachments: ["gmail.thread.attachments", ["gmail", "thread", "attachments", id]],
    draft: ["gmail.drafts.get", ["gmail", "drafts", "get", id]],
    labels: ["gmail.labels.list", ["gmail", "labels", "list"]],
  };
  const command = map[params.kind];
  if (!command) throw new Error(`unsupported read kind: ${params.kind}`);
  return { args: [...readBase(config, command[0]), ...command[1]] };
}

export function buildOrganizeCommand(params, config = defaults) {
  const ids = Array.isArray(params.ids) ? params.ids.filter(Boolean) : [];
  const simple = {
    archive: ["gmail.archive", "archive"],
    mark_read: ["gmail.mark-read", "mark-read"],
    mark_unread: ["gmail.unread", "unread"],
    trash: ["gmail.trash", "trash"],
  };
  if (simple[params.action]) {
    const [exact, command] = simple[params.action];
    if (!ids.length && !params.query) throw new Error("ids or query is required");
    const args = [...mutateBase(config, exact), "gmail", command, ...ids];
    optionalFlag(args, "--query", params.query);
    if (params.query) args.push(`--max=${Math.min(100, Math.max(1, params.max ?? 25))}`);
    if (params.thread === true && params.action === "archive") args.push("--thread");
    return { args };
  }
  let exact;
  let command;
  if (params.action === "label_threads") {
    if (!ids.length) throw new Error("ids is required for label_threads");
    exact = "gmail.labels.modify";
    command = ["gmail", "labels", "modify", ...ids];
    optionalFlag(command, "--add", Array.isArray(params.addLabels) ? params.addLabels.join(",") : "");
    optionalFlag(command, "--remove", Array.isArray(params.removeLabels) ? params.removeLabels.join(",") : "");
    if (!params.addLabels?.length && !params.removeLabels?.length) throw new Error("addLabels or removeLabels is required");
  } else if (params.action === "create_label") {
    exact = "gmail.labels.create";
    command = ["gmail", "labels", "create", required(params.label, "label")];
  } else if (params.action === "rename_label") {
    exact = "gmail.labels.rename";
    command = ["gmail", "labels", "rename", required(params.label, "label"), required(params.newLabel, "newLabel")];
  } else if (params.action === "delete_label") {
    exact = "gmail.labels.delete";
    command = ["gmail", "labels", "delete", required(params.label, "label")];
  } else {
    throw new Error(`unsupported organize action: ${params.action}`);
  }
  return { args: [...mutateBase(config, exact), ...command] };
}

export async function runGog(command, config) {
  const password = (await readFile(config.keyringPasswordFile, "utf8")).trim();
  if (!password) throw new Error("Gmail keyring password is unavailable");
  return new Promise((resolve, reject) => {
    const child = spawn(command.program || config.gogPath, command.args, {
      env: { ...evidenceEnvironment(config), GOG_KEYRING_BACKEND: "file", GOG_KEYRING_PASSWORD: password },
      stdio: ["pipe", "pipe", "pipe"],
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
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), command.timeoutMs || config.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error("Gmail output exceeded the configured limit"));
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2000);
      if (code !== 0) return reject(new Error(err || `gog exited with code ${code}`));
      try { resolve(out ? JSON.parse(out) : { ok: true }); } catch { resolve({ ok: true, output: out }); }
    });
    if (command.stdin !== undefined) child.stdin.end(command.stdin);
    else child.stdin.end();
  });
}

export function unwrapExternalText(value) {
  if (typeof value !== "string") return value;
  const match = value.match(/^<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\nSource:[^\n]*\n---\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>$/);
  return match ? match[1] : value;
}
