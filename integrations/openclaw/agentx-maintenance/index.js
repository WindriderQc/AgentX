import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import categories from "../../../shared/benchmarkCategories.js";
import { DEFAULT_AGENTS, SERVICES, TOOL, actionArgs, allowedActions, operatorContext, runAction, startGate } from "./action-runner.js";
import { queueBenchmark } from './queued-benchmark.js';

const receipt = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });

export default definePluginEntry({
  id: "agentx-maintenance",
  name: "AgentX Maintenance Actions",
  description: "Bounded AgentX maintenance actions (status, deploy, quarantine recovery, judge calibration, Benchmark batches) for operator agents.",
  register(api) {
    const command = api.pluginConfig?.actionCommand;
    const agentIds = Array.isArray(api.pluginConfig?.agentIds) && api.pluginConfig.agentIds.length
      ? api.pluginConfig.agentIds : [...DEFAULT_AGENTS];
    const grants = { agentIds, agentActions: api.pluginConfig?.agentActions };
    const gate = startGate(grants);
    const nativeRuns = new Map();
    // A batch starts only behind the runtime's approval: without the hook, no agent holds the start.
    const approvalHook = typeof api.on === "function";
    if (approvalHook) api.on("before_tool_call", (event, context) => {
      if (event.toolName === TOOL && event.toolCallId && (event.runId || context.runId)) {
        nativeRuns.set(`${context.sessionKey}:${event.toolCallId}`, event.runId || context.runId);
        if (nativeRuns.size > 1000) nativeRuns.delete(nativeRuns.keys().next().value);
      }
      return gate.before(event, context);
    }, { priority: 60 });

    api.registerTool(context => {
      if (!operatorContext(context, agentIds)) return null;
      const allowed = allowedActions(context.agentId, grants).filter(action => approvalHook || action !== "benchmark-batch-start");
      if (!allowed.length) return null;
      return {
        name: TOOL,
        label: "AgentX Maintenance Action",
        description: "Run one bounded AgentX maintenance action on the home instance and return its receipt. "
          + "status is read-only: served revisions, active work, lease holder. deploy rebuilds the named services "
          + "at a revision already on origin/main; it refuses while the LEAD.md lease is held or work is active. "
          + "recover-quarantine restarts a local Ollama that holds an UNKNOWN inference and attests the recovery; "
          + "it refuses while another inference or a workload runs there. recalibrate-judges runs the quick judge "
          + "calibration. benchmark-batch-prepare checks one model on one registered host against prompt categories "
          + "and returns a plan; it starts nothing. benchmark-batch-start launches that plan once: copy the start "
          + "object the preparation returned, unchanged; the owner is asked to approve it. benchmark-batch-status "
          + "reads a batch by the batchId a start returned. Read the receipt: outcome completed, refused (the reason "
          + "says why; held or busy can be tried later), unknown (a start whose result is not established: run the "
          + "same start again to reconcile it, never prepare another plan to retry) or failed (report it). "
          + "Never claim success without outcome completed. Run status first, and run only the actions the owner "
          + "or your mission asked for. You may run: " + allowed.join(", ") + ".",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: allowed },
            services: { type: "array", items: { type: "string", enum: [...SERVICES] }, minItems: 1, maxItems: 5 },
            revision: { type: "string", maxLength: 40 },
            waitMinutes: { type: "integer", minimum: 1, maximum: 30 },
            host: { type: "string", maxLength: 120 },
            model: { type: "string", maxLength: 120 },
            categories: { type: "array", items: { type: "string", enum: [...categories.BENCHMARK_CATEGORY_KEYS] }, minItems: 1 },
            levels: { type: "array", items: { type: "integer", minimum: 1, maximum: 5 }, minItems: 1, maxItems: 5 },
            repeats: { type: "integer", minimum: 1, maximum: 5 },
            judgeHost: { type: "string", maxLength: 80 },
            judgeModel: { type: "string", maxLength: 80 },
            name: { type: "string", maxLength: 60 },
            tag: { type: "string", maxLength: 40 },
            plan: { type: "string", maxLength: 40 },
            id: { type: "string", maxLength: 24 },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(_callId, params) {
          const args = actionArgs(params, context.agentId, allowed);
          if (params.action === "benchmark-batch-start" && !gate.passed(params, context, _callId)) {
            throw new Error("This start has no resolved allow-once runtime approval; nothing was launched");
          }
          if (['benchmark-batch-prepare', 'benchmark-batch-start'].includes(params.action)) {
            const runId = context.runId || nativeRuns.get(`${context.sessionKey}:${_callId}`);
            nativeRuns.delete(`${context.sessionKey}:${_callId}`);
            return receipt(await queueBenchmark(params, { ...context, runId, toolCallId: _callId }, api.pluginConfig));
          }
          return receipt(await runAction(command, args));
        },
      };
    }, { name: TOOL, optional: true });
  },
});
