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

[Work lifecycle](WORK_LIFECYCLE.md) defines task/issue routing, fact ownership,
actor roles and queue interpretation. Runtime adapters preserve Core's read
projections rather than infer automatic execution from a stored status.

Selected context sent to a cloud model crosses that boundary even when the
source service remains local. Expose the capability set intentionally and do
not treat all private data as automatically needed for every conversation.

Portable operating guidance lives in [the AgentX Core skill](../skills/agentx-core/SKILL.md).
Install its reviewed content in each participating runtime through that
runtime's native skill mechanism. A repository `AGENTS.md` guides development;
it is not automatically loaded by deployed agents. The skill explains how to
use capabilities and does not itself install tools or widen permissions.

## Existing transport

Core's [local advisory decision API](LOCAL_DECISIONS.md) classifies supplied
context using the existing principal pin. It is opt-in per call and executes
no domain action; runtime tool exposure and live qualification remain separate.

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

## Personal runtime parity

Personal harnesses retain the general Core MCP bus and may additionally connect
`/api/consumers/nestor/v1/mcp`. This owner transport is intentionally absent from
`/mcp` and `/mcp/memory`; family and narrow memory clients do not discover it.
It uses the existing Nestor consumer network/native access boundary, not a
new model-supplied audience. Do not configure it for a family runtime.

| Capability | Shared execution |
| --- | --- |
| Current local collaboration | `collaboration_context`, scoped selected display and sourced research excerpts; no work dispatch or business effect |
| Owner notes, mail journal and archive | Existing Core note, journal and owner-private recall services |
| Secretary and Accountant records | `team_brief`, including freshness and unavailable sections |
| Live specialist actions | `consult_team` with the installed native collaborator |
| Pipeline status and tasks | `ecosystem_snapshot`, `pipeline_tasks`, existing `create_todo` |
| Engineering provenance and authority | `work_relationships` and `work_authority`, shared Core dossier reads; no authenticated human principal or execution grant |
| Pipeline deliverables | `pipeline_artifacts`: registered receipts and verified bounded text |
| Storage file names | `find_files`, reading the existing index, not arbitrary disk content |
| Current public research | `web_search` through Core SearXNG; native Main for page reading |
| Heavy-work observation | `work_queue`, without dispatch or resource ownership |
| Existing coding and assistant workflows | Native Main consultation retains its installed tools and Pipeline policies |

Consultation requests require a stable UUID. Core stores the complete question,
dispatch fence, exact native session/run, answer and tool evidence in canonical
conversations. Duplicate delivery replays the same request; changed content
under its identity refuses. The asynchronous response must be polled. Lost
acceptance is reconciled by reading the original native session; ambiguity
retains the fence. No absence, timeout or process restart permits relaunch.
This transport does not grant shell access, bypass campaign approval or turn a
queued request into proof that work finished. Source tests validate contracts;
installation and live runtime parity require separate acceptance receipts.
