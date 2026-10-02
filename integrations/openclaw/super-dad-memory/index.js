import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { privateOwnerContext, updateState, nowIso } from "./store.js";
import { agentxRead, briefingFromCore, contextFor, recordTool, recordRun } from "./harness.js";
import { continuityHttpHandler, continuityOperations, householdWorkspace } from "./continuity.js";
import { mediaHttpHandler, mediaRoot } from "./media.js";
import { resolveAgentWorkspaceDir, resolveAgentEffectiveModelPrimary } from "openclaw/plugin-sdk/agent-runtime";

import { createCoreNotesClient, configuredJobContext } from "./core-notes.js";
import { createCoreVaultClient } from "./core-vault.js";
const receipt = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });
export default definePluginEntry({
  id: "super-dad-memory",
  name: "Nestor Personal Harness",
  description: "Private notes, requested context, observed action receipts and the existing personal briefing.",
  register(api) {
    const resolveWorkspace = id => resolveAgentWorkspaceDir(api.config, id);
    const workspaceFor = () => resolveWorkspace('main');
    const readNotes = createCoreNotesClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const writeVaultNote = createCoreVaultClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const secretaryContext = context => configuredJobContext(context, api.pluginConfig?.secretarySessionKeys);
    const morningContext = context => configuredJobContext(context, api.pluginConfig?.briefingSessionKeys);
    const readTasks = () => agentxRead(api.pluginConfig?.agentxUrl,
      "list_personal_tasks", { includeDone: false, includeNotes: false, limit: 100 });
    api.registerHttpRoute({ path: "/api/nestor/continuity", auth: "gateway", match: "exact",
      handler: continuityHttpHandler(continuityOperations({ workspace: workspaceFor(), config: api.config,
        resolveWorkspace, modelFor: id => resolveAgentEffectiveModelPrimary(api.config, id),
        // SDK read only: getSessionMessages invokes sessions.get; it never starts an agent.
        readHistory: async sessionKey => ({ sessionKey, ...await api.runtime.subagent.getSessionMessages({ sessionKey, limit: 100 }) }) })) });
    api.registerHttpRoute({ path: "/api/nestor/media", auth: "gateway", match: "exact",
      handler: mediaHttpHandler(mediaRoot(process.env, api.pluginConfig?.mediaRoot)) });
    api.registerTool((context) => {
      if (!privateOwnerContext(context, api.config) && !secretaryContext(context)) return null;
      return {
        name: "personal_memory",
        label: "Personal Memory",
        description: "Remember only an explicit personal fact, preference or decision. Search/list private notes; correct a note using its existing id; forget an exact id. Notes use AgentX Core, shared with the owner Nestor UI and voice. Confirm only the receipt; forgetting does not erase chat history.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["remember", "list", "search", "forget"] },
            text: { type: "string", minLength: 1, maxLength: 2000 },
            query: { type: "string", maxLength: 2000 },
            id: { type: "string", pattern: "^[a-f0-9]{24}$" },
            kind: { type: "string", enum: ["fact", "preference", "decision"] },
            expiresAt: { type: "string", maxLength: 40 },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(_callId, params) {
          return receipt(await readNotes(params));
        },
      };
    }, { name: "personal_memory", optional: true });

    api.registerTool(context => {
      if (!privateOwnerContext(context, api.config)) return null;
      return {
        name: "vault_note", label: "Vault Note",
        description: "File a Markdown note (summary, plan, idea, checklist) in the owner Obsidian vault inbox for review. Use when the owner asks to write something down as a note or document. Never for groceries or things to buy: those go on the agentx shopping_list. Never overwrites; the owner decides whether it joins the household documents. Report the returned file name only.",
        parameters: { type: "object", properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          body: { type: "string", minLength: 1, maxLength: 65536 },
          tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 12 },
        }, required: ["title", "body"], additionalProperties: false },
        async execute(_id, params) { return receipt(await writeVaultNote(params)); },
      };
    }, { name: "vault_note", optional: true });

    api.registerTool(context => {
      if (!privateOwnerContext(context, api.config)) return null;
      return {
        name: "nestor_context", label: "Nestor Context",
        description: "Get relevant private notes, previous goal and actual tool receipts. Set includeTasks to consult current personal tasks. No actions, emails or financial writes. Missing calendar or ledger access remains explicit.",
        parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 2000 }, includeTasks: { type: "boolean" } }, required: ["query"], additionalProperties: false },
        async execute(_id, params) {
          const workspace = workspaceFor(context);
          const evidence = await contextFor(workspace, params.query, { includeMemory: true, includeTasks: params.includeTasks === true, readTasks, readNotes });
          await updateState(workspace, state => ({ ...state,
            goal: { text: params.query.slice(-800), at: nowIso() } }));
          return receipt(evidence);
        },
      };
    }, { name: "nestor_context", optional: true });

    api.registerTool(context => {
      if (!privateOwnerContext(context, api.config) && !morningContext(context)) return null;
      return {
        name: "nestor_briefing", label: "Nestor Personal Briefing",
        description: "Get the French morning brief composed by AgentX Core from all open personal tasks (at most six lines). Relay its text as is. Read-only; does not deliver a message or imply calendar access.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { return receipt(briefingFromCore(await agentxRead(api.pluginConfig?.agentxUrl, "personal_briefing", {}))); },
      };
    }, { name: "nestor_briefing", optional: true });

    api.registerTool(context => {
      if (!privateOwnerContext(context, api.config)) return null;
      return {
        name: "nestor_network", label: "Nestor Network Devices",
        description: "List devices the home network collector has observed in AgentX: online now (default), unknown (not named or marked known), or all. Always relay the freshness sentence; a stale scan means the list is not confirmed now. Read-only.",
        parameters: { type: "object", properties: { scope: { type: "string", enum: ["online", "unknown", "all"] } }, additionalProperties: false },
        async execute(_id, params = {}) {
          return receipt(await agentxRead(api.pluginConfig?.agentxUrl, "network_devices", params.scope ? { scope: params.scope } : {}));
        },
      };
    }, { name: "nestor_network", optional: true });

    api.on("after_tool_call", async (event, context) => {
      const workspace = householdWorkspace(context, api.config, resolveWorkspace) || (privateOwnerContext(context, api.config) ? workspaceFor(context) : null);
      if (workspace) await recordTool(workspace, event, context);
    });
    api.on("agent_end", async (event, context) => {
      const workspace = householdWorkspace(context, api.config, resolveWorkspace) || (privateOwnerContext(context, api.config) ? workspaceFor(context) : null);
      if (workspace) await recordRun(workspace, event, context);
    });
  },
});
