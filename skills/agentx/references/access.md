# Access, discovery and provenance

## Resolve the instance and audience

- **Product.** [AgentX source](https://github.com/WindriderQc/AgentX) documents
  the capabilities. `demo` includes chat, RAG and Benchmark. `full` adds
  Nestor, Household and operator surfaces. Data is optional. Source
  availability says what can be installed. Verify each running service's
  revision, runtime grants and enabled integration before using it.
- **Private instance.** Use the known LAN HTTPS entry or the Core address
  and native operator entrances in the bundled `instance.md`, if present.
  Use the deployment's own inventory, schedules, pauses and receipts. When no
  address is known, ask for the intended instance. The ZIP's `served.md` dates
  the download and identifies the Core product revision. A proxy may report
  its internal scheme there. Use the known browser-facing HTTPS URL.
- **Owner/operator.** Use the owner bus only in an authorized personal
  runtime. Human routes follow the configured private LAN gateway. Home's
  human access requires no account or adult code. Native credentials and
  operator permissions still apply. A caller header identifies usage, never
  the human principal or an approval.
- **Famille.** Use the family's surface, tools or documented family routes.
  The server/runtime binds the scope. Honor the existing family memory
  boundary and `audience=family` where the family contract takes it. A tool
  argument, owner-only link, another persona or a different gateway cannot
  expand a family session's authority. Read the [Famille chapter](assistant.md#famille).

## Discover and call tools

1. Search the runtime tool catalogue for the exact unprefixed name from the
   chapter. The client may prefix names or hide definitions until searched.
   Check both the intended bus's catalogue and the client grant when one is
   absent.
2. On an already authorized Core origin, the buses accept JSON-RPC POST
   `initialize`, `tools/list`, and `tools/call` with
   `params: { name, arguments }`. Use the schema in `tools/list`.
   Send `x-service-caller: <stable caller>` for Core usage attribution.

   | Bus | Scope |
   |---|---|
   | `/mcp` | General Core skill bus for authorized clients. Includes owner-sensitive tools. |
   | `/mcp/memory` | Narrow memory and RAG view for permitted clients. |
   | `/api/consumers/nestor/v1/mcp` | Additional personal/owner tools, including Pipeline, queue, Janitor and Living Sources. |
   | Famille's installed tools | Server-scoped to Household. Use the family routes in [Living Sources](sources.md) for those reads. |

3. Check the transport and domain results. HTTP 200 can carry a JSON-RPC
   error or MCP `isError`. For HTTPS APIs read `{ ok, data | error }` or
   the older `{ status, message, data }` envelope.
4. If the tool is missing, use the chapter's documented HTTPS read or UI
   for the same authorized scope. Report a refusal, an unavailable producer
   or a disabled capability with the exact tool/route and returned code.
   Stop at an access refusal. A bare route 404 needs an exact path and
   deployment check. A successful partial/empty read carries its coverage.

The product's `integrations/mcp-relay/README.md` covers command-only MCP
clients and live catalogue refresh. For Codex sessions with a frozen native
catalogue, see `integrations/codex/README.md`. Installing the skill and
granting runtime tools are separate actions.

## Locate the governing source

Relative chapter links are in the same ZIP. For `docs/`, `integrations/`
and other repository paths, read `git show <product-revision>:<path>` or
the file in AgentX at that Git revision. Anchor deployed behavior to the
responsible service's own revision when it differs from Core's. Use
`docs/STATUS.md` for feature scope, `docs/ARCHITECTURE.md` for ownership,
`docs/OPERATIONS.md` for operator procedures, and
`docs/SHARED_AGENT_CAPABILITIES.md` for the shared tool contract.

Keep instance topology, runbooks, host roots and grants in the private
instance layer. Use observed timestamps, producer dates, scopes and
native receipts for current claims. Dependency reachability, source
freshness and functional acceptance are separate observations.

## Install or refresh

Get `/api/operator-skill` for the revision and file list, and
`/api/operator-skill/download` for the installable ZIP. The maintained
source is `skills/agentx/` in AgentX. The product chapters travel with the
ZIP. A deployment can add a private `references/instance.md`; keep that copy
in its authorized environment. Use the supported client sync or installation
mechanism. [Skill maintenance](dev.md#changing-this-skill)
