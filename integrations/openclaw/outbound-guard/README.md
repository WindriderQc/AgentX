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
