import { execFile } from "node:child_process";
import batchPlan from "../../../shared/benchmarkBatchPlan.cjs";

const { REQUEST_FIELDS, batchRequest, planRef, planId, batchId, describeRequest } = batchPlan;

// The closed list of AgentX bounded maintenance actions (#8, #394). The tool never
// runs anything else: no shell, no free arguments, and the actor is the agent.
export const TOOL = "agentx_maintenance_action";
export const ACTIONS = Object.freeze(["status", "deploy", "recover-quarantine", "recalibrate-judges",
  "benchmark-batch-prepare", "benchmark-batch-start", "benchmark-batch-status"]);
export const SERVICES = Object.freeze(["core", "benchmark", "benchmark-runner", "rag", "data"]);
export const DEFAULT_AGENTS = Object.freeze(["leadx"]);
const READ_ONLY = Object.freeze(["status", "benchmark-batch-status"]);
// What a configured operator agent holds without an agentActions entry: the
// actions it had before batches existed. Preparing and starting a batch is
// always an explicit grant.
const OPERATOR_DEFAULT = Object.freeze(["status", "deploy", "recover-quarantine", "recalibrate-judges", "benchmark-batch-status"]);
// The watcher observes; it mutates only through an explicit agentActions entry.
const READ_ONLY_BY_DEFAULT = Object.freeze(["overseer"]);
// The parameters each action accepts besides `action`; anything else is refused.
const FIELDS = Object.freeze({
  status: [], deploy: ["services", "revision", "waitMinutes"], "recover-quarantine": ["host"], "recalibrate-judges": ["host", "model"],
  "benchmark-batch-prepare": REQUEST_FIELDS, "benchmark-batch-start": ["plan", ...REQUEST_FIELDS], "benchmark-batch-status": ["id"],
});
const REVISION = /^(origin\/main|[0-9a-f]{7,40})$/;
const HOST = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,120}$/;
const TIMEOUT_MS = 35 * 60_000;
// OpenClaw shows an approval description of this length; a longer one is refused, never cut.
const APPROVAL_LENGTH = 256;

/** Only a configured operator agent, in its own unsandboxed session, gets the tool. */
export function operatorContext(context, agentIds = DEFAULT_AGENTS) {
  const agentId = context?.agentId;
  return Boolean(agentId && agentIds.includes(agentId) && !context.sandboxed
    && String(context.sessionKey || "").startsWith(`agent:${agentId}:`));
}

/** The actions one agent may run: its agentActions entry, or the default of its role. */
export function allowedActions(agentId, { agentIds = DEFAULT_AGENTS, agentActions } = {}) {
  if (!agentIds.includes(agentId)) return [];
  const entries = agentActions && typeof agentActions === "object" ? agentActions : {};
  const granted = Object.hasOwn(entries, agentId) ? entries[agentId]
    : READ_ONLY_BY_DEFAULT.includes(agentId) ? READ_ONLY : OPERATOR_DEFAULT;
  return ACTIONS.filter(action => Array.isArray(granted) && granted.includes(action));
}

function requestArgs(request) {
  return ["--host", request.host, "--model", request.model, "--categories", request.categories.join(","),
    "--levels", request.levels.join(","), "--repeats", String(request.repeats),
    ...(request.judgeHost ? ["--judge-host", request.judgeHost, "--judge-model", request.judgeModel] : []),
    ...(request.name ? ["--name", request.name] : []), ...(request.tag ? ["--tag", request.tag] : [])];
}

/** The request a start restates, checked against the plan reference that names it. */
function startRequest(params) {
  const request = batchRequest(params, { also: ["action", "plan"], judgeRequired: true });
  if (planRef(planId(params.plan), request) !== params.plan) {
    throw new Error("These parameters are not the ones prepared under this plan; copy the start the preparation returned");
  }
  return request;
}

/** Validated command-line arguments for one action the agent may run, with the agent as actor. */
export function actionArgs(params, agentId, allowed = ACTIONS) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("The action needs an object of parameters");
  const { action } = params;
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action; use one of ${allowed.join(", ")}`);
  if (!allowed.includes(action)) throw new Error(`${action} is not granted to this agent; it may run ${allowed.join(", ") || "nothing"}`);
  const unknown = Object.keys(params).filter(key => key !== "action" && !FIELDS[action].includes(key));
  if (unknown.length) throw new Error(`${action} does not accept: ${unknown.join(", ")}`);
  const args = [action];
  if (!READ_ONLY.includes(action)) args.push("--actor", `openclaw:${agentId}`);
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
  if (action === "benchmark-batch-prepare") args.push(...requestArgs(batchRequest(params, { also: ["action"] })));
  if (action === "benchmark-batch-start") args.push("--plan", params.plan, ...requestArgs(startRequest(params)));
  if (action === "benchmark-batch-status") args.push("--id", batchId(params.id));
  return args;
}

/**
 * A call receives a short-lived, single-use grant only after the runtime's
 * onResolution callback reports allow-once. Older runtimes that ignore that
 * callback cannot execute a start, even if they ignore requireApproval itself.
 */
export function startGate(grants = {}, { now = Date.now } = {}) {
  const approved = new Map();
  const key = (context, callId) => `${context?.agentId} ${context?.sessionKey} ${callId}`;
  return {
    before(event, context) {
      if (event?.toolName !== TOOL) return undefined;
      const params = event.params;
      if (params && typeof params === "object" && params.action !== "benchmark-batch-start") return undefined;
      try {
        if (!operatorContext(context, grants.agentIds)) throw new Error("this session holds no maintenance action");
        actionArgs(params, context.agentId, allowedActions(context.agentId, grants));
        if (typeof event.toolCallId !== "string" || !event.toolCallId) throw new Error("the runtime did not supply this tool call's identity");
        const description = `${params.plan}: ${describeRequest(startRequest(params))} [agent: ${context.agentId}]`;
        if (description.length > APPROVAL_LENGTH) throw new Error("the request is too long to show whole in an approval; use shorter names");
        const callKey = key(context, event.toolCallId), plan = params.plan, requestedAt = now();
        let resolved = false;
        approved.delete(callKey);
        return { requireApproval: { title: "Start a Benchmark batch", description, severity: "warning",
          allowedDecisions: ["allow-once", "deny"], timeoutMs: 300000, timeoutBehavior: "deny",
          onResolution(decision) {
            if (resolved) return;
            resolved = true;
            for (const [id, grant] of approved) if (grant.expiresAt <= now()) approved.delete(id);
            approved.delete(callKey);
            if (decision === "allow-once" && now() - requestedAt <= 300000) {
              approved.set(callKey, { plan, expiresAt: now() + 30000 });
            }
          } } };
      } catch (error) {
        return { block: true, blockReason: `Benchmark batch start refused: ${error.message}` };
      }
    },
    passed(params, context, callId) {
      const callKey = key(context, callId), grant = approved.get(callKey);
      if (!grant || grant.plan !== params?.plan || grant.expiresAt <= now()) return false;
      approved.delete(callKey);
      return true;
    },
  };
}

/** Run the instance's action command and return its JSON receipt, whatever the outcome. */
export function runAction(command, args, { execImpl = execFile, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof command !== "string" || !command.startsWith("/")) {
    return Promise.reject(new Error("The plugin needs an absolute actionCommand"));
  }
  return new Promise((resolve, reject) => {
    execImpl(command, args, { timeout: timeoutMs, maxBuffer: 8 << 20, shell: false }, (error, stdout) => {
      let value;
      try { value = JSON.parse(String(stdout || "").trim()); }
      catch { return reject(new Error(`The action produced no receipt${error ? ` (${error.message})` : ""}`)); }
      if (!value || value.contract !== "agentx.maintenance-action/v1" || value.action !== args[0]
        || !["completed", "refused", "unknown", "failed"].includes(value.outcome)) {
        return reject(new Error("The action returned an invalid or mismatched maintenance receipt; its outcome is unknown"));
      }
      const actorIndex = args.indexOf("--actor");
      if (value.outcome === "completed" && actorIndex >= 0 && value.actor !== args[actorIndex + 1]) {
        return reject(new Error("The action receipt names another actor; its outcome is unknown"));
      }
      if (args[0] === "benchmark-batch-start" && value.outcome === "completed") {
        try { batchId(value.result?.batchId); }
        catch { return reject(new Error("The start receipt has no valid Benchmark batch ID; its outcome is unknown")); }
        if (value.result?.plan !== args[args.indexOf("--plan") + 1]) {
          return reject(new Error("The start receipt names another plan; its outcome is unknown"));
        }
      }
      return resolve(value);
    });
  });
}
