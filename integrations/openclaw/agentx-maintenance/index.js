import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ACTIONS, SERVICES, actionArgs, operatorContext, runAction } from "./action-runner.js";

const receipt = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });

export default definePluginEntry({
  id: "agentx-maintenance",
  name: "AgentX Maintenance Actions",
  description: "Bounded AgentX maintenance actions (status, deploy, quarantine recovery, judge calibration) for operator agents.",
  register(api) {
    const command = api.pluginConfig?.actionCommand;
    const agentIds = Array.isArray(api.pluginConfig?.agentIds) && api.pluginConfig.agentIds.length
      ? api.pluginConfig.agentIds : ["leadx", "overseer"];

    api.registerTool(context => {
      if (!operatorContext(context, agentIds)) return null;
      return {
        name: "agentx_maintenance_action",
        label: "AgentX Maintenance Action",
        description: "Run one bounded AgentX maintenance action on the home instance and return its receipt. "
          + "status is read-only: served revisions, active work, lease holder. deploy rebuilds the named services "
          + "at a revision already on origin/main; it refuses while the LEAD.md lease is held or work is active. "
          + "recover-quarantine restarts a local Ollama that holds an UNKNOWN inference and attests the recovery; "
          + "it refuses while another inference or a workload runs there. recalibrate-judges runs the quick judge "
          + "calibration. Read the receipt: outcome completed, refused (held or busy, try later) or failed (report it). "
          + "Never claim success without outcome completed. Run status first, and deploy only what the owner or "
          + "your mission asked for.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...ACTIONS] },
            services: { type: "array", items: { type: "string", enum: [...SERVICES] }, minItems: 1, maxItems: 5 },
            revision: { type: "string", maxLength: 40 },
            waitMinutes: { type: "integer", minimum: 1, maximum: 30 },
            host: { type: "string", maxLength: 120 },
            model: { type: "string", maxLength: 120 },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(_callId, params) {
          return receipt(await runAction(command, actionArgs(params, context.agentId)));
        },
      };
    }, { name: "agentx_maintenance_action", optional: true });
  },
});
