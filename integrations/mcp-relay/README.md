# MCP relay for local-command clients

Claude Desktop (chat, not its Code tab) launches MCP servers as local
commands. `relay.mjs` is that command: it forwards each stdio JSON-RPC message
to one Core bus over HTTP and writes Core's answer back. It holds no tool
logic, so Desktop sees exactly the tools Core advertises, and new tools need
no relay change. Node 18 or later, no dependencies.

Claude Code, Codex and Hermes speak HTTP MCP directly; they do not need it.

## Install (Claude Desktop)

Copy `relay.mjs` somewhere stable on the machine (for example
`%USERPROFILE%\.agentx\bin\relay.mjs`) and add one entry per bus to
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

Restart Claude Desktop. `AGENTX_CALLER` is the name Core's tool usage report
(`GET /api/agent-tools/usage`) shows for these calls.

## Behaviour

- Requests and notifications go out unchanged with `x-service-caller`.
- JSON and SSE (`text/event-stream`) answers are both returned.
- An unreachable bus answers each request with JSON-RPC error `-32000`
  naming the URL; notifications are dropped.
- `AGENTX_RELAY_TIMEOUT_MS` (default 120000) bounds each request.

Test: `node --test integrations/mcp-relay/relay.test.mjs`.
