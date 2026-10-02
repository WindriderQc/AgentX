import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { outboundDecision } from "./policy.js";
import { nativeActionProvenance, toolActionReceipt } from '../action-provenance.mjs';

export default definePluginEntry({
  id: "outbound-guard",
  name: "AgentX Outbound Guard",
  description: "Owner approval, enforced in code, before an agent messages anyone outside the owner's own conversations.",
  register(api) {
    const ownerTargets = Array.isArray(api.pluginConfig?.ownerTargets) ? api.pluginConfig.ownerTargets : [];
    const provenanceFor = context => nativeActionProvenance(context, api.config, api.pluginConfig);
    const record = (event, provenance, phase, decision) => {
      try {
        api.logger?.info?.(JSON.stringify(toolActionReceipt(event, provenance, phase, decision)));
        return true;
      } catch { return false; }
    };
    api.on('before_tool_call', (event, context) => {
      const provenance = provenanceFor(context);
      const decision = event.toolName === 'message' ? outboundDecision(event.params, { ownerTargets, provenance }) : null;
      const recorded = record(event, provenance, 'requested', decision?.block ? 'blocked' : decision?.requireApproval ? 'approval_required' : 'unchanged');
      if (!recorded) return { block: true, blockReason: 'The action provenance receipt could not be recorded.' };
      return decision || undefined;
    }, { priority: 60 });
    api.on('after_tool_call', (event, context) => record(event, provenanceFor(context), 'observed'));
  },
});
