# AgentX Maintenance Actions (OpenClaw plugin)

Gives configured operator agents one tool, `agentx_maintenance_action`, that
runs a bounded AgentX maintenance action (`./agentx action`, see
`docs/OPERATIONS.md`, "Bounded maintenance actions") and returns its JSON
receipt.

- Only the agents in `agentIds` (default `leadx`, `overseer`) see the tool, in
  their own unsandboxed sessions.
- The tool runs `actionCommand` (an absolute path, usually an instance wrapper
  that exports the instance variables and calls `./agentx action`) without a
  shell. Arguments are built from validated parameters only; the actor is
  always `openclaw:<agentId>`.
- The action itself takes the instance lease, refuses while it is held or work
  is active, and records its receipt. The agent reports the receipt's outcome.

Configuration in `openclaw.json`:

```json
"plugins": {
  "load": { "paths": ["<checkout>/integrations/openclaw/agentx-maintenance"] },
  "entries": {
    "agentx-maintenance": {
      "enabled": true,
      "config": { "actionCommand": "/path/to/instance/agentx-action", "agentIds": ["leadx", "overseer"] }
    }
  }
}
```

Each operator agent also needs `agentx_maintenance_action` in its tool
`alsoAllow` list.
