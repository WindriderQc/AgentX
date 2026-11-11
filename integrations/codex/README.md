# Automatic AgentX tool discovery in Codex

`mcp_catalog_watch.py` observes explicitly selected AgentX HTTP MCP catalogues
and refreshes Codex through its local app-server control API. One shared watcher
serves loaded chats; it performs no inference and calls no tools. Python 3.10+
on a Unix host, standard library only.

Core's stateless buses do not publish catalogue-change events. Codex versions
that gate MCP notifications behind `mcp_tool_list_changed` may also retain that
feature's initial value for existing chats. A normal configuration reload does
not enable it there. This adapter works with those running chats without
restarting the daemon or interrupting turns.

## Install

Copy `mcp_catalog_watch.py` and `app_server_rpc.py` into one stable directory
outside a disposable worktree. Keep the selected buses configured as HTTP
servers in Codex. Preserve their caller headers, tool restrictions and timeouts.
Never connect an owner bus to a family or child client.

```sh
python3 /path/to/agentx-codex/mcp_catalog_watch.py \
  --server agentx --server agentx-owner
```

The default socket is `$CODEX_HOME/app-server-control/app-server-control.sock`
(otherwise `~/.codex/...`). `--socket` overrides it. Default polling is 30 seconds;
`--interval` overrides it and `--once` performs one bounded pass. The native daemon
must already run and expose its control socket. Do not start or restart it for
discovery. Run the watcher under the instance's existing user-service manager
for persistence; starting this new watcher does not restart other services.

`--state-file` defaults to `$XDG_STATE_HOME/agentx/codex-catalog-watch.json`
(otherwise `~/.local/state/...`). Keep it outside Git. A lock prevents duplicate
watchers using the same state file. The journal records only a pending reload,
without tool definitions, credentials, URLs or business results.

## Refresh contract

- Only `tools/list` is posted to each selected configured bus. Pagination must
  complete, with valid unique names. Ordering does not change the fingerprint;
  names, descriptions, schemas and other tool metadata do.
- A complete changed catalogue replaces only that server URL's
  `catalog_revision` query parameter with its deterministic fingerprint. It uses
  native `config/batchWrite` with the source file's expected version, followed
  by `config/mcpServer/reload`. Other query values and configuration remain intact.
- Unchanged catalogues cause no writes or reloads. This also reconciles the
  initial connection once, without a manual URL bump or bus tool call.
- Only user-owned HTTP entries are editable. Managed or unsupported transports
  refuse. A failed catalogue retains its previous revision while healthy buses
  can advance. Errors retry with bounded backoff; conflicting configuration is
  reread, never overwritten blindly.
- A durable pending-reload journal closes the gap between a configuration write
  and reload. Lost responses are reconciled from current configuration, without
  repeating a business action.
- Codex publishes refreshed MCP bindings while retaining connections needed by
  in-flight calls. The watcher never uses turn interruption, thread unloading,
  cancellation, service restart, model routing or deployment APIs. New tools
  become visible at the client's next catalogue/sampling refresh.

The generic [stdio relay](../mcp-relay/README.md) emits standard MCP notifications
for clients that support them. Use one discovery path per Codex server; the
shared watcher avoids a polling relay process for every loaded chat.

Tests: `python3 -m unittest discover -s integrations/codex -p 'test_*.py'`.
Synthetic HTTP catalogues and native CAS fixtures cover changes, pagination,
scope, concurrent edits and lost responses. Source tests do not attest live
client discovery; installation acceptance also checks native advertised tools
and a read-only tool call. No model is involved in either check.
