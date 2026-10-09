# AgentX Maintenance Actions (OpenClaw plugin)

Gives configured operator agents one tool, `agentx_maintenance_action`, that
runs a bounded AgentX maintenance action (`./agentx action`, see
`docs/OPERATIONS.md`, "Bounded maintenance actions") and returns its JSON
receipt.

- Only the agents in `agentIds` (default `leadx`) see the tool, in their own
  unsandboxed sessions. The agent comes from the runtime context of the call,
  never from a parameter, and the actor is always `openclaw:<agentId>`.
- Each agent holds a closed subset of actions (see below). The tool's schema
  lists only those, and a call for another action is refused before anything
  runs.
- The tool runs `actionCommand` (an absolute path, usually an instance wrapper
  that exports the instance variables and calls `./agentx action`) without a
  shell. Arguments are rebuilt from validated parameters only; a parameter the
  action does not define is refused, by the schema and again inside the tool.
- The action itself takes the instance lease, refuses while it is held or work
  is active, and records its receipt. The agent reports the receipt's outcome:
  `completed`, `refused`, `unknown` or `failed`.

## Actions per agent

`agentActions` maps an agent of `agentIds` to the actions it may run, from
`status`, `deploy`, `recover-quarantine`, `recalibrate-judges`,
`benchmark-batch-prepare`, `benchmark-batch-start` and `benchmark-batch-status`.
An entry replaces the default; an empty list withholds the tool. An entry for
an agent outside `agentIds` grants nothing.

Without an entry:

| Agent | Actions |
|---|---|
| an agent listed in `agentIds` | `status`, `deploy`, `recover-quarantine`, `recalibrate-judges`, `benchmark-batch-status`: an operator named in the configuration keeps deployment and recovery |
| `overseer`, when listed | `status`, `benchmark-batch-status` only: it mutates nothing without an entry |
| any other agent, such as `main` or a family agent | no tool |

Preparing and starting a batch are never a default. Give an agent only what its
mission needs, for example a measurement operator:

```json
"plugins": {
  "load": { "paths": ["<checkout>/integrations/openclaw/agentx-maintenance"] },
  "entries": {
    "agentx-maintenance": {
      "enabled": true,
      "config": {
        "actionCommand": "/path/to/instance/agentx-action",
        "agentIds": ["leadx"],
        "agentActions": {
          "leadx": ["status", "benchmark-batch-prepare", "benchmark-batch-start", "benchmark-batch-status"]
        }
      }
    }
  }
}
```

Each operator agent also needs `agentx_maintenance_action` in its tool
`alsoAllow` list. The plugin loads from the AgentX checkout: it reads the batch
contract and the categories from `shared/`, so its directory alone is not
enough. The instance wrapper must export `AGENTX_ACTION_RECEIPTS_DIR`, where
plans are kept.

## Benchmark batches

1. `benchmark-batch-prepare` takes one registered local Ollama `host`, one
   installed `model`, `categories`, and optionally `levels`, `repeats` (1 to
   5), `judgeHost` with `judgeModel`, `name` and `tag`. It starts nothing. Its
   receipt holds the plan reference, the projected tests and a `start` object.
2. `benchmark-batch-start` takes that `start` object unchanged: the plan
   reference and the values it names, including the judge the plan pinned. The
   reference carries a digest of the values, so a start with other values is
   blocked.
3. `benchmark-batch-status` takes the `batchId` a start returned and reads the
   batch.

There is no parameter for a request body, a prompt, a judge prompt, a paid
approval, a harness target, several judges or a cloud model. Before preflight
can probe a model, a fixed read of `/api/tags` on the registered host verifies
the candidate and judge inventory and refuses `remote_host` or `remote_model`,
including a remotely served model hidden behind a local alias.

### Approval of a start

The plugin registers a `before_tool_call` hook, the pattern of
`integrations/openclaw/outbound-guard`. For every `benchmark-batch-start` it
either blocks the call (agent without the grant, another session, a sandbox,
malformed or changed values) or returns `requireApproval`: allow once or deny,
denied when unanswered after five minutes. The description names the plan
reference, the model and host, the categories, levels and repeats, the judge,
the name and tag, and the agent. A request whose description would exceed 256
characters is blocked instead of being shown cut. No parameter stands for the
approval; an `approved` field is an unknown parameter.

The hook grants nothing when it merely asks. Its `onResolution` callback must
receive `allow-once` before the tool can execute. The short-lived grant is bound
to the agent, session, tool call ID and plan, and consumed once; denial, timeout,
cancellation, a missing callback or an expired grant cannot launch. The hook
and tool must run in the same process. When the runtime offers no hook registration, no
agent receives `benchmark-batch-start`.

A start in a scheduled or unattended session waits for the same approval and is
denied when nobody answers: this version has no unattended launch.

### What the tests prove, and what they do not

`npm test` here runs the plugin against a stand-in for the OpenClaw plugin API,
and the action tests run against a stand-in for Benchmark. They establish the
local contract: validation, grants, the hook's decision and the tool's refusal
without it.

They do not establish, and an instance must check on its installed runtime:

- that the installed OpenClaw version calls `before_tool_call` for plugin tools
  and resolves `requireApproval` through `onResolution`, with its real tool
  call ID. A runtime that ignores this decision or callback cannot execute a start;
- that the hook and the tool run in the same process, without which every start
  is refused;
- that the approval reaches the owner on the channel in use, such as Telegram,
  shows the whole description, and that a denial or a timeout stops the call;
- that the approved parameter snapshot reaches the tool unchanged. The action
  refuses values that do not match the plan's digest.

The callback contract is documented in [OpenClaw tool policy hooks](https://docs.openclaw.ai/plugins/hooks/tool-policy).
