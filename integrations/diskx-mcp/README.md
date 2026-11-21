# DiskX remote connector

This relay gives Claude.ai one authenticated, read-only MCP tool,
`janitor_report_view`. The relay calls Core's existing owner tool with empty
arguments and returns the stored report's status, UTC date and dated DiskX
link. Opening the link requires access to the private instance. The relay does
not publish Core or give the client a copy of the owner catalogue.

## Run on the private network

Use Node 22 or later. Start `server.mjs` as an unprivileged process on the
private network, supervised by the instance's service manager.

| Variable | Value |
| --- | --- |
| `AGENTX_DISKX_MCP_KEY_FILE` | Path to a private file containing a random, lowercase 64-character hexadecimal key. Generate a dedicated key with `openssl rand -hex 32`. |
| `AGENTX_DISKX_MCP_CORE_ORIGIN` | Private Core origin, default `http://127.0.0.1:3180`. |
| `AGENTX_DISKX_MCP_LINK_ORIGIN` | Private HTTPS origin where the owner opens DiskX. |
| `AGENTX_DISKX_MCP_PORT` | Loopback port, default `8313`. |

Point a dedicated HTTPS route at this loopback listener and configure the
proxy's upstream `Host` as `127.0.0.1:8313` (or the selected port). A tunnel
can carry this route without an inbound port on the private network. Keep
the route independent of Core's gateway and exclude all other paths.

In the owner's Claude.ai account, create a web connector pointing to the
dedicated HTTPS URL ending in `/mcp`. Choose **No sign in** for OAuth and
configure a fixed **Request header** named `x-api-key` with the relay
key. Keep the key in the connector settings and the private file. To revoke
access, replace the key and restart the relay. Update the connector header
only for clients that should keep access.

## Verify

Run `node --test integrations/diskx-mcp/server.test.mjs`. On the deployed
public route, verify that a request without the key gets HTTP 401 and that
the authenticated catalogue contains only `janitor_report_view`. Check that
an unrelated path or tool cannot reach Core. In a new Claude.ai chat, ask for
an existing dated DiskX report in read-only mode. Verify the tool's execution
in the chat trace and the `claude-ai-diskx` caller in Core's tool usage report.
Open the returned link on the private network and check its report date.
