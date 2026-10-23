# Shared capabilities for agents

AgentX Core and its domain services own reusable capabilities. OpenClaw,
Hermes, browser surfaces and other clients consume them. Connecting a new
runtime does not create another owner of personal memory, documents, tasks,
business rules or action results.

## Development contract

This contract applies when developing tools from Codex, Claude Desktop,
OpenClaw, Hermes or another coding client. Project instructions link here;
the chosen development environment does not change capability ownership.

- Implement domain behavior once in the responsible AgentX service. An existing
  capability is reused before a new route or implementation is introduced.
- Publish a bounded contract through an existing supported API or the Core MCP
  skill bus. Extend the shared contract when functionality is missing.
- Keep runtime adapters limited to transport, session identity, argument/result
  translation and presentation. They do not reproduce stores or business logic.
- Verify domain behavior in AgentX and verify each changed adapter separately.
  Successful tool discovery does not prove successful execution through a client.
- Keep deployment addresses, credentials, owner data and execution receipts in
  the private instance layer or native stores, outside the public repository.

## Runtime contract

The client uses only the tools actually exposed to its session. Shared code does
not grant identical permissions to every client: owner, family, scheduled jobs
and specialists retain their existing scope and approval requirements.

Core retains canonical data and domain results. A runtime may retain its native
execution history and session memory; these are not a replacement store for
Core's shared personal facts, tasks or documents. An action is confirmed only
after its successful result, with the available domain and execution receipts.

Selected context sent to a cloud model crosses that boundary even when the
source service remains local. Expose the capability set intentionally and do
not treat all private data as automatically needed for every conversation.

Portable operating guidance lives in [the AgentX Core skill](../skills/agentx-core/SKILL.md).
Install its reviewed content in each participating runtime through that
runtime's native skill mechanism. A repository `AGENTS.md` guides development;
it is not automatically loaded by deployed agents. The skill explains how to
use capabilities and does not itself install tools or widen permissions.

## Existing transport

Core's `/mcp` endpoint exposes the shared skill bus. `/mcp/memory` is a narrower
view of the same implementation, limited to personal-note search/save and RAG
search. Use the catalogue advertised by the selected endpoint rather than
assuming every product tool exists in every deployment.

Both endpoints retain the installed adult/private-LAN access boundary; they are
not a new public endpoint or an independent authentication system. See
[operations](OPERATIONS.md) for access, memory scope and tool-specific limits.
Allowlisting a native runtime's MCP tools narrows its exposed catalogue; it does
not replace server-side authorization.

OpenClaw uses its existing Core integration and permission model. Hermes can
consume the same bus with its native MCP client. Provider choice and the number
of agent roles do not change the domain owner. Direct AgentX/Ollama inference
does not become a tool-executing agent merely because a capability is published.

The [presentation/read contract](CONTENT_PRESENTATION.md) follows this same
ownership: Core projects and validates the exact Analytics view snapshot;
Hermes uses `read_presentation` on this bus and OpenClaw relays it through its
optional private-owner adapter. The runtime does not implement another page
reader. Current selection and display observation do not grant domain access.

## Qualification

Separate these observations:

1. The server advertises a tool and the client exposes it in the intended scope.
2. An actual client turn calls it and receives the expected bounded result.
3. Any domain mutation is present in the canonical service, with its receipt.
4. The visible conversation and interruption/recovery behavior remain correct.

Use isolated fixtures for source checks. Queue live model and shared-compute
qualification through [the heavy-work procedure](HEAVY_WORK_QUEUE.md). Retain
native admission, stable request identity and recovery rules. Do not replay a
possibly executed mutation to compensate for an uncertain transport result.
