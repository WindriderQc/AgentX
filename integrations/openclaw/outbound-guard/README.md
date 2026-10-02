# AgentX Outbound Guard (OpenClaw plugin)

Enforces ADR 0003 rule 3 for the native `message` tool: before an agent sends,
edits, deletes, polls or takes any other channel action toward a destination
that is not one of the owner's own conversations, OpenClaw asks the owner
(allow once or deny; an unanswered request is denied).

These pass without a prompt:

- read-only actions (`read`, `reactions`, `pins`, `search`, info and list actions);
- a reply in the current conversation (no explicit `target`);
- a destination listed in `ownerTargets`, including its forum topics and threads.

Configuration in `openclaw.json` (instance values stay outside Git):

```json
"plugins": {
  "load": { "paths": ["<checkout>/integrations/openclaw/outbound-guard"] },
  "entries": {
    "outbound-guard": {
      "enabled": true,
      "config": { "ownerTargets": ["telegram:<owner chat id>", "telegram:<household group id>"] }
    }
  }
}
```

Scheduled jobs that deliver to the owner keep working when their destination
is listed. Gmail sending keeps its own approval in the Gmail Secretary plugin.

Every native tool call and observed result also emits an
`agentx.tool-action-receipt/v1` to the gateway logger. Its
`agentx.action-provenance/v1` comes from host session context: `owner_turn`,
`ingested_content`, `scheduled`, `delegated` or `unknown`. Session, run and
tool-call references are hashes; arguments and result content are not logged.
An observed result is not proof of successful delivery.

The classifier reuses Nestor's configured `secretarySessionKeys` and
`briefingSessionKeys` from `plugins.entries.super-dad-memory.config`. Cron
sessions are background work even when their requester is the owner. Background
message tools may send a report to an explicit `ownerTargets` destination;
external contacts, implicit destinations and destructive actions are blocked.
Gmail's own gate blocks background sending and destructive mailbox changes.
Reads, review evidence, draft creation and bounded triage retain their behavior.
The owner initiates any required external action in a conversation and gives
the existing one-time approval.

Provenance describes the session, not the causal origin of every prompt token.
It grants no authority and never replaces tool approvals or tool permissions.
These native adapters load from the AgentX checkout, including their shared
provenance modules; installing a plugin directory alone is insufficient.
