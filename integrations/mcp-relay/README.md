# MCP relay and automatic tool discovery

Claude Desktop (chat, not its Code tab) launches MCP servers as local
commands. `relay.mjs` is that command: it forwards each stdio JSON-RPC message
to one Core bus over HTTP and writes Core's answer back. It holds no tool
logic: the catalogue and execution stay in Core. Node 18 or later, no dependencies.

HTTP clients can also use the relay when their cached catalogue needs automatic
updates. Core's stateless HTTP buses do not currently publish catalogue-change
events. The relay advertises `tools.listChanged` and polls `tools/list` every
30 seconds after the MCP handshake. A changed name, description or schema emits
`notifications/tools/list_changed`; supporting clients such as Codex fetch the
new catalogue. Additions and removals need no relay update or URL revision.

Discovery only reads tool definitions. It does not call tools, load models,
restart Core, reconnect the bus or cancel active requests. Each relay observes
only its configured URL, preserving the general, memory and owner boundaries.
Never give a family or child client the owner URL.

## Install (Claude Desktop)

Copy **both** `relay.mjs` and `catalog-watch.mjs` into the same stable directory
(for example `%USERPROFILE%\.agentx\bin\`) and add one entry per bus to
`claude_desktop_config.json` (`%APPDATA%\Claude` on Windows):

```json
{
  "mcpServers": {
    "agentx": {
      "command": "node",
      "args": ["C:\\Users\\you\\.agentx\\bin\\relay.mjs", "https://agentx.example/mcp"],
      "env": { "AGENTX_CALLER": "claude-desktop" }
    },
    "agentx-owner": {
      "command": "node",
      "args": ["C:\\Users\\you\\.agentx\\bin\\relay.mjs", "https://agentx.example/api/consumers/nestor/v1/mcp"],
      "env": { "AGENTX_CALLER": "claude-desktop" }
    }
  }
}
```

Load the configuration using the client's supported mechanism. Clients without
hot reload require a fresh connection for this one-time installation; discovery
thereafter uses the existing connection. `AGENTX_CALLER` is the name Core's tool usage report
(`GET /api/agent-tools/usage`) shows for these calls.

## Codex

Use stable, absolute paths outside a disposable worktree:

```toml
[mcp_servers.agentx]
command = "node"
args = ["/path/to/agentx-mcp-relay/relay.mjs", "https://agentx.example/mcp"]
env = { AGENTX_CALLER = "codex" }

[mcp_servers.agentx-owner]
command = "node"
args = ["/path/to/agentx-mcp-relay/relay.mjs", "https://agentx.example/api/consumers/nestor/v1/mcp"]
env = { AGENTX_CALLER = "codex" }
```

Replace the HTTP transport fields (`url`, `http_headers`) in these entries;
retain existing tool allowlists, timeouts and other unrelated settings. Use
Codex's supported configuration reload when available. Do not restart a shared
daemon to refresh a catalogue. Installation acceptance checks the client's
advertised tools and a read-only call separately from source tests.

## Behaviour

- Requests and notifications go out unchanged with `x-service-caller`, the
  negotiated MCP protocol version and the upstream session ID when supplied.
- JSON and SSE (`text/event-stream`) answers are both returned.
- The initialize response additionally advertises `tools.listChanged` when
  Core offers tools. An initial change notification reconciles discovery, then
  only complete changed catalogues trigger another. Internal discovery replies
  are consumed by the relay, never forwarded as client replies.
- Paginated catalogues are read completely. Invalid pages and unreachable buses
  retain the last good fingerprint and retry with backoff (up to 16 intervals).
  Ordering alone does not count as a change. Polls run serially and stop on
  stdin closure; pending client calls still drain normally.
- An unreachable bus answers each request with JSON-RPC error `-32000`
  naming the URL; notifications are dropped.
- `AGENTX_RELAY_TIMEOUT_MS` (default 120000) bounds each request.
- `AGENTX_RELAY_CATALOG_POLL_MS` (default 30000) controls discovery frequency.

Test: `node --test integrations/mcp-relay/*.test.mjs`. Fixtures exercise catalogue
changes while a call remains in flight; they do not perform live inference.
