# OpenClaw overseer job

A native OpenClaw command job runs `openclaw-overseer-wrapper.js` to produce a
read-only holistic review of the AgentX instance. The wrapper runs one turn of
the `overseer` agent through the OpenClaw gateway and prints the agent's report
only after its transcript passes `openclaw-overseer-postcondition.js`. AgentX
does not install or schedule the job; the native OpenClaw scheduler owns it.

## Contract

1. Read the instruction text from stdin (UTF-8, non-empty, at most 16 KiB).
2. Check the installed contract with the `openclaw` CLI:
   - `config get agents --json`: exactly one `overseer` agent with profile
     `minimal`, `alsoAllow` exactly `read` and `agentx__ecosystem_snapshot`,
     no `allow`, and `session_status` denied;
   - `sessions --agent overseer`: an `agent:overseer:` session exists;
   - `mcp probe agentx --json`: the `agentx` MCP server lists exactly the ten
     `REQUIRED_MCP_TOOLS` with no diagnostics;
   - `gateway call tools.effective`: the session sees exactly those two tools, or
     only `read` with a single pending-MCP notice.
3. Run `gateway call agent` with a fresh run id, `deliver: false`, the message
   tool disabled and a 600-second agent timeout.
4. Read the run's messages with `gateway call sessions.get` and verify them: one
   successful `read` of `BOOTSTRAP.md`, then `agentx__ecosystem_snapshot`
   (`mode: full`, `maxChars: 60000`) returning a schema-5 snapshot, no other tool,
   and a final report with the five required headings in order.
5. Print the report to stdout and exit 0.

`--check` performs step 2 only and prints `OVERSEER_WRAPPER_CHECK_OK`. Any
failure prints `OVERSEER_WRAPPER_FAILED code=<code>` on stderr and exits 1.

The postcondition also runs alone on a transcript file:
`node openclaw-overseer-postcondition.js --transcript <file>` prints
`OVERSEER_POSTCONDITION_OK ...` or `OVERSEER_POSTCONDITION_FAILED code=<code>`.
The file must be a `<uuid>.jsonl` inside the overseer sessions directory.

## Configuration

| Setting | Default | Use |
|---|---|---|
| `OPENCLAW_OVERSEER_THINKING` | required | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max` or `ultra` |
| `OPENCLAW_BIN` | `openclaw` on `PATH` | OpenClaw CLI executable |
| `OPENCLAW_HOME` | `~/.openclaw` | Postcondition CLI: sessions under `agents/overseer/sessions` |
| `OPENCLAW_OVERSEER_SESSIONS_ROOT` | derived from `OPENCLAW_HOME` | Postcondition CLI: explicit sessions directory |

The instruction text, workspace references, schedule, delivery target and job
id belong to the native OpenClaw job configuration on the instance host, outside
Git. Point the job at this directory as its working directory.

## Tests

`node scripts/test-native-tools.cjs` runs the synthetic tests in `test/`. They
stub the OpenClaw CLI and never start OpenClaw, the gateway or an agent.
