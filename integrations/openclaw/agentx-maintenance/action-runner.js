import { execFile } from "node:child_process";

// The closed list of AgentX bounded maintenance actions (#8). The tool never
// runs anything else: no shell, no free arguments, and the actor is the agent.
export const ACTIONS = Object.freeze(["status", "deploy", "recover-quarantine", "recalibrate-judges"]);
export const SERVICES = Object.freeze(["core", "benchmark", "benchmark-runner", "rag", "data"]);
const REVISION = /^(origin\/main|[0-9a-f]{7,40})$/;
const HOST = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,120}$/;
const TIMEOUT_MS = 35 * 60_000;

/** Only a configured operator agent, in its own unsandboxed session, gets the tool. */
export function operatorContext(context, agentIds = ["leadx", "overseer"]) {
  const agentId = context?.agentId;
  return Boolean(agentId && agentIds.includes(agentId) && !context.sandboxed
    && String(context.sessionKey || "").startsWith(`agent:${agentId}:`));
}

/** Validated command-line arguments for one action, with the agent as actor. */
export function actionArgs(params = {}, agentId) {
  const { action } = params;
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action; use one of ${ACTIONS.join(", ")}`);
  const args = [action];
  if (action !== "status") args.push("--actor", `openclaw:${agentId}`);
  if (action === "deploy") {
    const services = Array.isArray(params.services) ? [...new Set(params.services)] : [];
    if (!services.length || services.some(service => !SERVICES.includes(service))) {
      throw new Error(`deploy needs services from ${SERVICES.join(", ")}`);
    }
    args.push("--services", services.join(","));
    if (params.revision !== undefined) {
      if (!REVISION.test(params.revision)) throw new Error("revision must be origin/main or a commit sha");
      args.push("--revision", params.revision);
    }
    if (params.waitMinutes !== undefined) {
      if (!Number.isInteger(params.waitMinutes) || params.waitMinutes < 1 || params.waitMinutes > 30) throw new Error("waitMinutes must be 1 to 30");
      args.push("--wait-minutes", String(params.waitMinutes));
    }
  }
  if (action === "recover-quarantine") {
    if (!HOST.test(String(params.host || ""))) throw new Error("recover-quarantine needs the Ollama host URL");
    args.push("--host", params.host);
  }
  if (action === "recalibrate-judges") {
    if (params.host !== undefined) {
      if (!HOST.test(params.host)) throw new Error("host must be an Ollama URL");
      args.push("--host", params.host);
    }
    if (params.model !== undefined) {
      if (!MODEL.test(params.model)) throw new Error("model is not a valid model name");
      args.push("--model", params.model);
    }
  }
  return args;
}

/** Run the instance's action command and return its JSON receipt, whatever the outcome. */
export function runAction(command, args, { execImpl = execFile, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof command !== "string" || !command.startsWith("/")) {
    return Promise.reject(new Error("The plugin needs an absolute actionCommand"));
  }
  return new Promise((resolve, reject) => {
    execImpl(command, args, { timeout: timeoutMs, maxBuffer: 8 << 20, shell: false }, (error, stdout) => {
      try { return resolve(JSON.parse(String(stdout || "").trim())); }
      catch { return reject(new Error(`The action produced no receipt${error ? ` (${error.message})` : ""}`)); }
    });
  });
}
