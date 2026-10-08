import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { privateOwnerContext, updateState, nowIso } from "./store.js";
import { agentxRead, briefingFromCore, contextFor, recordTool, recordRun } from "./harness.js";
import { continuityHttpHandler, continuityOperations, householdWorkspace } from "./continuity.js";
import { mediaHttpHandler, mediaRoot } from "./media.js";
import { resolveAgentWorkspaceDir, resolveAgentEffectiveModelPrimary } from "openclaw/plugin-sdk/agent-runtime";

import { createCoreNotesClient, configuredJobContext } from "./core-notes.js";
import { createCoreVaultClient } from "./core-vault.js";
import { createCoreJournalClient } from "./core-journal.js";
import { createCoreBriefClient } from "./core-brief.js";
import { createCoreIdentifiersClient, householdOwnerSession } from "./core-identifiers.js";
import { registerLocalImages } from "./local-images.js";
const receipt = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });
export default definePluginEntry({
  id: "super-dad-memory",
  name: "Nestor Personal Harness",
  description: "Private notes, requested context, observed action receipts and the existing personal briefing.",
  register(api) {
    registerLocalImages(api);
    const resolveWorkspace = id => resolveAgentWorkspaceDir(api.config, id);
    const workspaceFor = () => resolveWorkspace('main');
    const readNotes = createCoreNotesClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const writeVaultNote = createCoreVaultClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const mailJournal = createCoreJournalClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const teamBrief = createCoreBriefClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const identifiers = createCoreIdentifiersClient({ baseUrl: api.pluginConfig?.agentxUrl });
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
        description: "Remember only an explicit, lasting personal fact, preference or decision in one sentence. Never a summary of a mail, thread or document (use mail_journal), never identifiers or account numbers. Search/list private notes; correct a note using its existing id; forget an exact id. Notes use AgentX Core, shared with the owner Nestor UI and voice. Confirm only the receipt; forgetting does not erase chat history.",
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
          // The session, not the model, says where a remembered fact came from.
          const provenance = secretaryContext(context) ? "mail-review" : morningContext(context) ? "scheduled" : "conversation";
          return receipt(await readNotes(params.action === "remember" ? { ...params, provenance } : params));
        },
      };
    }, { name: "personal_memory", optional: true });

    api.registerTool(context => {
      if (!privateOwnerContext(context, api.config) && !secretaryContext(context)) return null;
      return {
        name: "mail_journal", label: "Mail Journal",
        description: "Owner-only journal of what happened in the owner's mail. record: one dated digest per thread (or per message for a separate event) with the thread id, when it happened, who and a short factual summary; recording the same thread/message again replaces it. search: find past mail events by words, thread or dates. Entries expire after the journal retention. A lasting fact, deadline or decision drawn from mail also goes to personal_memory in one sentence.",
        parameters: { type: "object", properties: {
          action: { type: "string", enum: ["record", "search"] },
          threadId: { type: "string", minLength: 1, maxLength: 200 },
          messageId: { type: "string", maxLength: 200 },
          occurredAt: { type: "string", maxLength: 40 },
          subject: { type: "string", maxLength: 300 },
          counterpart: { type: "string", maxLength: 200 },
          summary: { type: "string", minLength: 1, maxLength: 4000 },
          tags: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 12 },
          sourceRef: { type: "string", maxLength: 500 },
          query: { type: "string", maxLength: 500 },
          since: { type: "string", maxLength: 40 },
          until: { type: "string", maxLength: 40 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        }, required: ["action"], additionalProperties: false },
        async execute(_id, params) { return receipt(await mailJournal(params)); },
      };
    }, { name: "mail_journal", optional: true });

    api.registerTool(context => {
      if (!privateOwnerContext(context, api.config)) return null;
      return {
        name: "team_brief", label: "Team Brief",
        description: "The standing brief a collaborator keeps up to date for you, computed by Core, read-only. Read it before consulting the collaborator. secretary: what she flagged for you (a reply, something urgent, a deadline) and dated digests of the mail she has processed, newest first (days = how far back, default 2). comptable: latest balance per account with its date, in/out/net of the recent months, pending alerts, statements to review. Every brief has the same shape: covers (what it holds), sections (the data) and beyond (what still needs the collaborator). Answer only from the sections, say it comes from that collaborator's brief, quote *Display amounts as given and never add or convert amounts. A section marked unavailable was not read: say so.",
        parameters: { type: "object", properties: {
          member: { type: "string", enum: ["secretary", "comptable"] },
          days: { type: "integer", minimum: 1, maximum: 366 },
        }, required: ["member"], additionalProperties: false },
        async execute(_id, params) { return receipt(await teamBrief(params)); },
      };
    }, { name: "team_brief", optional: true });

    api.registerTool(context => {
      if (!privateOwnerContext(context, api.config)) return null;
      return {
        name: "personal_identifier", label: "Personal Identifier",
        description: "The owner's sensitive identifiers (NIQ, NAS, REEE, account and card numbers) are kept encrypted; notes and mail entries show them as [coffre: label …1234]. list: labels and last digits. reveal: the full value of one id, only when the owner needs it for a task, and only in Super Dad; on Telegram, say it can be shown in Super Dad. To keep a new identifier, save it in a note: Core moves it to the vault.",
        parameters: { type: "object", properties: {
          action: { type: "string", enum: ["list", "reveal"] },
          id: { type: "string", pattern: "^[a-f0-9]{24}$" },
        }, required: ["action"], additionalProperties: false },
        async execute(_id, params) {
          if (params.action === "reveal" && !householdOwnerSession(context)) {
            return receipt({ ok: false, shown: false, reason: "Identifier values are shown only in Super Dad, on the home network." });
          }
          return receipt(await identifiers(params));
        },
      };
    }, { name: "personal_identifier", optional: true });

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
      if (workspace) await recordTool(workspace, event, context, { config: api.config, pluginConfig: api.pluginConfig });
    });
    api.on("agent_end", async (event, context) => {
      const workspace = householdWorkspace(context, api.config, resolveWorkspace) || (privateOwnerContext(context, api.config) ? workspaceFor(context) : null);
      if (workspace) await recordRun(workspace, event, context, { config: api.config, pluginConfig: api.pluginConfig });
    });
  },
});
