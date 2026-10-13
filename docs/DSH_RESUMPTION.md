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

Install DSH separately and retain its version, original native settings,
histories, workspace and isolation configuration outside Git. The launcher
`integrations/coding/dsh-studio.sh` prepares only its private Studio settings
copy. It retains native preferences, selects the Core provider and declares the
principal context. Open's temporary per-chat hold inherits the same context.
Changing a pin's context requires restarting Studio to refresh its descriptor.

Configure `AGENTX_CORE_URL`, `DSH_STUDIO_DSH_ROOT`, `DSH_STUDIO_SETTINGS_FILE`,
`DSH_STUDIO_WORKSPACE_ROOT`, `DSH_STUDIO_STATE_ROOT`, `DSH_STUDIO_PORT` and
`DSH_STUDIO_TRUSTED_HOST` in the host's existing service environment. Preserve
`DSH_STUDIO_ISOLATION` (`bubblewrap` or an explicitly configured `host` boundary)
and `AGENTX_NODE_BIN`. The installed DSH dependency supplies the YAML parser.

The web process holds no model lock or host-wide Benchmark claim. Core owns
admission and verified completion for each streamed generation, including tool
turns and disconnects. Native uncertain outcomes remain fenced; no Studio
restart clears them. The older bounded headless claim wrapper is unchanged.

Configure `DSH_STUDIO_PUBLIC_URL` in Core as an HTTPS origin on the same hostname
as AgentX; a different port is supported. Keep the existing secret and signed
launch cookie. The private LAN reverse proxy protects Studio with Core's
`/api/dsh/access-check`. Launch through `/api/dsh/control-launch` (the AgentX
Studio entry) to obtain the cookie; a direct URL without that cookie refuses.
No upstream DSH fork or version upgrade is required.

For native Main, add `agentx-primary` to the existing Core-routed provider's
catalog with the principal context and select it for Main only. Preserve its
tools, permissions, histories and other agents' concrete models. The same
alias works through the Ollama and OpenAI adapters. Configure Coding Team's
`AGENTX_CODING_MODEL=auto` to follow its existing Core coding route on new work.

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
