# OpenClaw model execution

This native plugin provides model execution without an agent loop and exposes
an expurgated model/agent catalogue to AgentX. Provider transports, authentication
and fixed parameters come from the installed OpenClaw SDK and configuration.

Install this directory with OpenClaw's existing local-plugin workflow. Enable
`agentx-model-execution` in its private plugin configuration. `agentIds` optionally
restricts the auth scopes and agent profiles exposed to AgentX. Set
`maxRequestCostNanodollars` for paid model calls; its default is zero. Never put
provider credentials or instance configuration in this directory.

Both execution routes require native gateway authentication. The gateway stays
private. AgentX's existing gateway URL/token identify the service. The native
agent Responses endpoint retains its existing agent mode and continuity path.

Run `npm test` here. The installed-SDK test is skipped when the native package is
unavailable. It uses the actual SDK registry, payload policy and streaming parser
with an injected native fetch port; it opens no provider socket. Model mode is
open only for the runtime version and APIs admitted by `qualifiedModelApi`
(`native.mjs`). Google also requires the pinned executable SDK/dependency digest
computed by `sdk-fingerprint.mjs`; a dependency patch closes that transport even
if its version string stays unchanged. The digest is published on native Google
targets and included in their fingerprints. Native module resolution from both
the SDK and `@openclaw/ai` must select the shared hashed dependencies; a shadow
copy closes Google qualification. Unvisited symlinks inside `dist` also refuse.
Qualify each runtime update or new API with the same transport
tests before adding it there or refreshing benchmark pins.

For a required Google qualification, run
`AGENTX_REQUIRE_OPENCLAW_SDK=1 node --test test/native-google-qualification.test.mjs`
here. Missing SDK code fails this command. Its synthetic native provider and
intercepted network use no real credential or provider socket; a skipped suite
is not qualification or installed-instance acceptance.

Reproduce from the official npm package in a fresh worktree (Node.js 24 or
newer). A temporary prefix keeps the package and its dependencies separate from
installed runtimes. Its manifest pins `@openclaw/ai` 2026.9.4 and `@google/genai`
2.19.0. Installation scripts stay disabled; do not run the OpenClaw CLI.

```bash
qualification_dir="$(mktemp -d)"
npm install --global --prefix "$qualification_dir" --ignore-scripts --no-audit --no-fund openclaw@2026.9.4
mkdir -p integrations/openclaw/model-execution/node_modules
ln -s "$qualification_dir/lib/node_modules/openclaw" integrations/openclaw/model-execution/node_modules/openclaw
AGENTX_REQUIRE_OPENCLAW_SDK=1 npm test --prefix integrations/openclaw/model-execution
```

Run these commands from the repository root. The official distribution's
Google SDK fingerprint is
`cfad322578d04c51596f5745c29aec4686b98fa42caf75bfedce1b616747d65a`.
The other admitted digest identifies separately tested SDK code; it is not an
instruction to patch the official package. No runtime configuration, credentials
or SDK copy belongs in Git. CI without this isolated SDK may skip native tests;
its green status does not replace the required-SDK qualification above.

See [execution sources](../../../docs/EXECUTION_SOURCES.md) for the API,
ownership, budgets, benchmark isolation and observable limitations.

When an SDK final result fails validation, the native plugin saves its exact
result and raw usage privately under
`OPENCLAW_STATE_DIR/agentx-model-execution/terminal-evidence/` (default:
`~/.openclaw/agentx-model-execution/terminal-evidence/`). Files use mode 0600.
The error carries a hash and opaque reference; authenticated operators can read
that reference with `GET /api/agentx/execution/model-terminal?ref=...` without
calling a provider. Core retains this reference with the original failed call.
It proves custody of the SDK result, not valid usage, known cost or successful
execution. Unknown billing and retry fences remain in force. Results lost by
older plugin versions cannot be reconstructed by this feature.
