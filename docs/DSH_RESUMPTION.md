# DSH Studio: deferred integration and resumption

## Decision

This deployment defers DSH Studio integration. DSH remains a candidate for
later use: its source, installation, private settings, workspaces and receipts
are preserved. This is not a decision to delete DSH or abandon the coding team.

The Studio service is stopped and its autostart disabled; its service
definition and private state are retained. Do not enable Studio as an
always-running service, and do not display a deferred Studio as a healthy,
available coding entry point.

The Core task queue, native OpenClaw execution, independent verification and PR
review remain the coding-team direction. Their own deployment acceptance is
separate; deferring Studio does not establish that they are already live.

## Observed issue

[`dsh-studio.sh`](../integrations/coding/dsh-studio.sh) launches the entire web
server inside [`with-agentx-claim.js`](../integrations/coding/with-agentx-claim.js).
The claim and host-wide lock follow the child process lifetime, rather than an
individual inference request. The wrapper advertises a 24-hour estimate and
renews its heartbeat while Studio stays open. The estimate is not an idle
timeout or evidence that the claim automatically ends after 24 hours.

An idle, permanently running Studio would therefore keep an inference host
reserved and can prevent ordinary Nestor or benchmark requests from using it.
This is a launch/lifecycle integration problem, not evidence that DSH itself is
unsuitable. An installed Studio launcher may differ from this repository's
launcher; blindly replacing its service would change runtime behavior.

Do not fix this by clearing live claims, bypassing admission, or silently routing
Studio directly to Ollama alongside coordinated consumers. Preserve the existing
claim's termination, heartbeat and release/restore semantics.

## What to retain outside Git

- Exact installed DSH version, service unit, environment and autostart state.
- Native settings, provider/model selection and selected inference host.
- Studio and headless workspaces, histories and lifecycle receipts.
- Existing isolation choice, Bubblewrap configuration and shared lock location.
- A backup copy of the currently installed launcher and its source identity.

Use the paths the deployment actually configures: the DSH install directory,
its native settings file, the Studio workspace directory and the launcher's
state directory are deployment settings, not repository defaults. Upstream
default locations are discovery hints, not permission to replace a different
instance layout. Host inventories and secrets stay private.

## Resume here

1. Reinspect the installed DSH version and its supported inference lifecycle
   hooks. Reuse Core's admission authority; establish whether a claim can cover
   each bounded generation, including tool turns and cancellation.
2. Prefer request-scoped reservations if DSH exposes a reliable lifecycle. If it
   does not, evaluate an explicitly started, bounded coding session that releases
   the host when that session ends. These are options to investigate, not
   implemented behavior or approval to restart Studio automatically.
3. Preserve the current model/context contract, private workspaces, isolation
   and independent verification. Do not add another scheduler or task store.
4. Verify idle coexistence with Nestor, an actual coding request, tool execution,
   cancellation, process loss and release recovery. An uncertain inference must
   retain its quarantine until reconciled; no timer may simply erase it.
5. Verify the real UI and workspace continuity, then deliberately restore the
   selected service startup mode. Record code, tests and live acceptance
   separately before advertising Studio as available again.

The existing claim regression suite is
`node --test integrations/coding/test/with-agentx-claim.test.js shared/agentxClaimAttestation.test.js`.
It checks the wrapper contract; it does not prove DSH's real inference lifecycle
or coexistence with Nestor.
