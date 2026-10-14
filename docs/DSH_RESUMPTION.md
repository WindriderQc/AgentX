# DSH Studio setup and qualification

DSH Studio uses Core's existing OpenAI gateway, `/api/hermes-openai/v1`, with
the following-model alias `agentx-primary`. Core resolves that name to its
`daily_operator` route on every request. Concrete model names keep explicit
selection. The isolated Coding Team worker also uses DSH, with its own task
claim, frozen concrete model and native capacity receipts.

Nerve Center's Routing section selects Standard or Abliterated. This replaces
the existing principal pin, retaining its context, keep-alive and sibling pins,
then updates matching ordinary task routes. Dedicated routes (including family,
reading, speech, embeddings and utility hosts) retain their configured choice.
The existing maintenance admission refuses a busy switch. A known loading
failure restores and verifies the prior pins; an uncertain outcome retains
native quarantine for its owner to reconcile. There is no extra preference
database or model scheduler.

## Native Studio

The supported runtime is DSH **0.2.0-rc.2**. Install it separately and retain its version, original native settings,
histories, workspace and isolation configuration outside Git. The launcher
`integrations/coding/dsh-studio.sh` prepares a private launch overlay. Upstream
imports ordinary legacy preferences once into its native profile; the managed
overlay selects the Core provider on every start and declares the
principal context. Open's temporary per-chat hold inherits the same context.
Changing a pin's context requires restarting Studio to refresh its descriptor.

Configure `AGENTX_CORE_URL`, `DSH_STUDIO_DSH_ROOT`, `DSH_STUDIO_SETTINGS_FILE`,
`DSH_STUDIO_WORKSPACE_ROOT`, `DSH_STUDIO_STATE_ROOT`, `DSH_STUDIO_PORT` and
`DSH_STUDIO_TRUSTED_HOST` in the host's existing service environment. Preserve
`DSH_STUDIO_ISOLATION` (`bubblewrap` or an explicitly configured `host` boundary)
and `AGENTX_NODE_BIN`. The installed DSH dependency supplies the YAML parser.
DSH 0.2 also authenticates its own Web requests. Set `DSH_STUDIO_LAUNCH_FILE`
in the launcher to a private file, and in Core to that file's read-only mount
path. The launcher publishes upstream's process launch token with mode 0600,
redacts it from service output and removes its own record on exit. Core's
existing launcher grants its signed cookie, then opens DSH's native token
exchange; upstream issues its own cookie and removes the token from the URL.
Missing or malformed records refuse with 503. Never put this file in Git.

The web process holds no model lock or host-wide Benchmark claim. Core owns
admission and verified completion for each streamed generation, including tool
turns and disconnects. Native uncertain outcomes remain fenced; no Studio
restart clears them. The older bounded headless claim wrapper is unchanged.

Configure `DSH_STUDIO_PUBLIC_URL` in Core as an HTTPS origin on the same hostname
as AgentX; a different port is supported. Keep the existing secret and signed
launch cookie. The private LAN reverse proxy protects Studio with Core's
`/api/dsh/access-check`. Launch through `/api/dsh/control-launch` (the AgentX
Studio entry) to obtain the cookie; a direct URL without that cookie refuses.
No upstream DSH fork is required. Keep the old runtime and a stopped snapshot
of Studio state before upgrading: new session generations preserve their source,
but older runtimes cannot read subsequent changes written by a newer format.

For native Main, add `agentx-primary` to the existing Core-routed provider's
catalog with the principal context and select it for Main only. Preserve its
tools, permissions, histories and other agents' concrete models. The same
alias works through the Ollama and OpenAI adapters. Configure Coding Team's
`AGENTX_CODING_MODEL=auto` to follow its existing Core coding route on new work.
Set `AGENTX_DSH_ROOT` to the reviewed runtime directory for both coding wrappers.
Coding Team uses a JSON launch overlay and the concrete capacity claim's context;
its observer selects the highest plaintext session generation, including V4.

## Optional browser tools and project skills

Studio can mount the upstream experimental Playwright provider by setting
`DSH_STUDIO_BROWSER_EXECUTABLE` to an installed Chromium executable. Install
`@deepseek-ai/dsh-browser-use@0.2.0-rc.2` and
`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.0-rc.2` in its
private `$DSH_HOME/profiles/web` profile. Keep DSH service peers supplied by the
runtime, rather than installing duplicate copies: use `auto-install-peers=false`
in the profile's `.npmrc` with pnpm, or `--legacy-peer-deps` with npm. Retain the
profile's bundle declarations and installation lockfile. Chromium and the
package manager must be installed before launch; no model installs them.

The launcher uses a separate headless browser per live Studio Session and mounts
its executable read-only under Bubblewrap. Browser state is not conversation
memory. Keep the Coding Team's network isolation and single-worker guard;
browser plugins are enabled only for the human-operated Studio. Reuse compatible
project skills through DSH's existing `.agents/skills` or `.dsh/skills` discovery.
No extra memory service, scheduler or agent-team layer is needed.

## Optional prior-session recall and shared memory

Set `DSH_STUDIO_MEMORY_ENABLED=true` in the existing Studio service environment
and install `@deepseek-ai/dsh-tool-session-query@0.2.0-rc.2` in its private
`$DSH_HOME/profiles/web` profile, retaining its existing dependencies and shared
runtime peers as for browser tools above. The default is `false`; other launch
overlays stay unchanged.
The managed overlay enables upstream's SQLite full-text search on first use
with an in-memory derived index. Original session logs remain authoritative and
are reindexed after restart. Five native read-only tools search, trace and read
history; cross-session access requires the exact same workspace path. Search
returns at most ten hits and asks the model to narrow broader queries.

The same opt-in connects DSH's native MCP client to Core's `/mcp/memory` entry.
That view of the existing bus exposes and executes only `memory_search`,
`memory_remember` and `rag_search`. It reuses owner notes, their correction ids
and document retrieval. The default `/mcp` bus keeps its complete product view.
This profile narrows the tool surface; it is not a new authentication boundary.
An unavailable memory entry fails plugin activation rather than silently
creating a second note store. Project decisions and logs belong in project
files and session history; durable personal facts belong in the shared notes.

These are human Studio capabilities. Automatic Coding Team workers retain their
existing network boundary and task-local evidence. Disabling the Studio setting
and restarting removes the optional tools without deleting notes or histories.

## Qualification

Source/unit tests do not prove installation. Before live qualification, enroll
the work in [Core's heavy-work queue](HEAVY_WORK_QUEUE.md), then retain native
admission and the instance's maintenance owner. Record evidence outside Git:

- Profiler's exact-artifact receipts and the operator-selected context.
- Standard → Abliterated → Standard, all sibling pins resident without spill.
- Main and Studio model identity, context and one actual native tool turn.
- Idle Studio coexistence, cancellation/process loss and native release.
- Signed launch access and preserved workspace/history; configure startup only
  after the installed service and entry have been checked.

If a reply is lost, reconcile the original operation identity and its native
receipt before another launch. Never delete coordination records to restore
service. PR review and CI remain the coding worker's acceptance gate.
