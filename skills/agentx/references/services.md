# Find an AgentX capability

Search the current session catalogue for the service, intent and short tool
name (runtimes add prefixes). Inspect the schema, bus, read/write action and
returned evidence. Where a client hides deferred tools, search before
declaring one missing. An operator with the correct connection can use MCP
`initialize`, then `tools/list` on that bus. Send `x-service-caller` for
attribution. The general bus may itself include writes; its listing is not a
household allowlist. A family device keeps its own surface and audience.

| Want to know or do | Capability to look for | Evidence to return |
|---|---|---|
| Which dependencies answer? | General `check_health`; `ecosystem_snapshot` for broader state; family Living Source `agentx` for scoped reachability | Named component, observation time, failed or partial checks. For functional acceptance read the requested service's own result. |
| What do hosts, storage and the network report? | General `gpu_status`, `storage_summary`, `network_devices` | Source host or index and timestamp. A cached inventory may predate this read. |
| What does a configured Home Assistant plug report? | Owner `home_assistant_plug`; use its advertised device key or the documented default | On/off, watts, optional cumulative kWh, Home Assistant report time versus check time. Missing sensors stay unknown. This reader cannot switch the plug. |
| Which documents or files match? | General `rag_search` for passages; owner `find_files` for indexed filenames; photo tools for household photos | Cite a relevant source and date, or the index freshness. A filename alone supplies no content. |
| What is on the personal screen? | `read_presentation` with the displayed reference; owner `collaboration_context` for the current personal conversation | Selected page, visibility and observed values or their absence. Nestor's **Pages et services** opens configured destinations; an external link gives no reading or control of that service. |
| Work with household or creative features | Discover `shopping_list`, `add_idea`, `propose_family_chore`, `draft_plant_card`, `propose_world_change`, `world_proposal_status` or the [ArtX reader](artx.md) as appropriate | Check the session's audience and schema. Return the saved item, proposal status or display observation for the requested action. |
| Consult personal history, research or specialist work | Owner `life_history`, `mail_recall`, `web_search`, `team_brief`, `consult_team` | Return the dated native item or bounded specialist result. [Assistant](assistant.md) covers consent and uncertain consultations. |
| Hear an animal or sound effect | Discover `get_sound` with a sound ID or French/English query | Return the local recording or labelled effect for client playback. Only a client playback observation can establish that it played. |
| Read the owner's morning task brief | Personal session, `personal_briefing({})` | Relay its brief and retain `sourceCoverage`. Other producers may have changed since the underlying tasks were recorded. |
| Correct owner memory or file an Obsidian note for review | Owner bus `personal_memory` manages the notes Nestor uses. General bus `write_vault_note` files an authorized note in the owner's Obsidian vault inbox. | Verify the note identity or inbox receipt. Forgetting needs the exact note ID. Inbox placement precedes owner selection for retrieval. |
| Track an inspected message needing action | Authorized Secretary workflow, `add_email_action` | Use the Gmail thread ID to create or reuse one restricted action card for Urgent, Needs Reply or Waiting. Return the card result and exclude the message body. |
| Determine whether an authorized specialist consultation may use billable cloud | `get_escalation_recommendation` immediately before Answer-Heavy delegation | Use the current budget verdict within the owner's scope. An unavailable or refusing gate stops that delegation. |

If the session lacks the tool, check whether a documented **same-audience**
read exists on the configured instance. [Read routes](endpoints.md) include Core,
Benchmark and RAG. A 401/403, a family restriction or a disabled private surface
ends that path. State the missing capability, audience or connection and what
you could still verify. Never try a different identity, a raw backend port or
an owner bus to get around a refusal. An unavailable service is distinct from
an authorized, successful read returning no records.

In a product checkout at the revision in `served.md`, use
`docs/SHARED_AGENT_CAPABILITIES.md` for transports, `docs/NESTOR_WEB_GUIDE.md`
for the screen directory and `docs/LAN_ACCESS_SCOPE.md` for surface boundaries.
The private instance owns its inventory, schedules and enabled adapters.
