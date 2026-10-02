import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { outboundApproval } from "./policy.js";

export default definePluginEntry({
  id: "outbound-guard",
  name: "AgentX Outbound Guard",
  description: "Owner approval, enforced in code, before an agent messages anyone outside the owner's own conversations.",
  register(api) {
    const ownerTargets = Array.isArray(api.pluginConfig?.ownerTargets) ? api.pluginConfig.ownerTargets : [];
    api.on("before_tool_call", event => {
      const approval = outboundApproval(event.params, { ownerTargets });
      if (!approval) return;
      // A timeout or an unanswered request denies (ADR 0003).
      return { requireApproval: { ...approval, allowedDecisions: ["allow-once", "deny"], timeoutMs: 300000, timeoutBehavior: "deny" } };
    }, { matcher: ["message"], priority: 60 });
  },
});
