# Benchmark harness broker

This optional host process serves the existing AgentX Benchmark target catalog
and WorkerEnvelope/WorkerReceipt contracts. It preserves isolated Ollama,
Hermès execution and, when qualified, native OpenClaw benchmarks. Cloud models
use OpenClaw model mode; agent profiles retain their distinct native agent mode.
It does not create another benchmark UI, model router or personal memory store.
Historical broker wire identifiers remain compatible with existing receipts.

The broker binds to loopback by default. Fixed executor paths and profile/runtime
pins, bounded process execution, private per-cell workspaces, capacity locks,
claim ownership, target identity and spend grants retain their source checks.
Native agent results remain distinct from isolated model scores and cannot serve
as an isolated judge. No model download or paid request occurs during installation.

## Executable repository cells

When native agent execution is qualified, a cell for an executable prompt pins a
product repository fixture id and fingerprint in its WorkerEnvelope. OpenClaw
receives the project in its per-cell
workspace with hidden tests withheld. After the turn, the adapter captures the
edit and grades it against an independent original fixture snapshot, including
public/hidden tests, regression checks and allowed edit paths. The receipt keeps
patch and fixture digests, test status and whether the executable contract passed.
A correct final explanation cannot replace a passing verifier. Native receipts
remain distinct from isolated model quality rankings. Catalog materialization
pins adapter version 2.4.0 and must be rerun after updating the executor.

Native agent Benchmark targets are available only for local Ollama cells, whose
cell-wide turn, tool-call and token ceilings Core enforces before each model call
(#897). Benchmark opens one budget per cell in Core from the WorkerEnvelope
budgets and adds its opaque `budgetId` to each runtime claim. Every model call of
the cell reaches Core's OpenClaw bridge (`/api/openclaw-ollama`), which reserves
the turn before dispatch and refuses it with a 409 once a ceiling is reached, so
no Ollama request is opened. The adapter rejects execution with
`OPENCLAW_NATIVE_AGENT_BUDGET_UNQUALIFIED` before reading the profile, staging a
workspace or starting OpenClaw when the target is not local Ollama or the claims
carry no single budget, and after reading the profile when its provider URL does
not point at Core's bridge. The budgetId only names a record Core holds: Core
refuses an unknown, closed or expired id, and claims without one.

Cloud and paid native agents reach their provider without Core, so nothing
enforces their budget before each call. They stay unavailable (#506), and
catalog materialization keeps their metadata and pins with `available: false`.
A timeout or a final usage check cannot qualify these limits.

## Instance configuration

Keep catalogs, credentials, installed runtime paths, audit rows and spend ledgers
outside Git. Use `benchmark-harness-broker.env.example` and the service example
as templates for the chosen account and checkout. The source has no npm runtime
dependencies; run `node server.js` with the explicit environment injected.
Do not source an untrusted env file as shell code.

Copy `profiles/openclaw-native-v1.example.json` outside Git and replace its example
model, context, host and parameters with the accepted instance profile. The
materializer now requires that explicit profile; it cannot silently select a
former operator's model or endpoint:

```bash
node materialize-openclaw-catalog.js /absolute/openclaw.mjs /external/targets.json /external/local-profile.json
```

Additional absolute profile paths append named subscription targets. Each profile
must select its auth-owning native agent and supported billing policy; private
authentication is not copied into the public catalog. The actual installed OpenClaw schemas and runtime
files are inspected and pinned when this command is explicitly run.

`targets.example.json` is disabled example data. Replace its placeholders and
recreate pins for every deployed executable/profile, including dependencies such
as `shared/agentxClaimAttestation.js` for the isolated Ollama executor. Local
execution still requires a live matching Core host claim. The native OpenClaw
local profile requires Core's runtime bridge, whose activation is a
separate prerequisite; do not bypass it with an uncoordinated Ollama call.

Cloud model targets are projected from the native execution catalogue:

```bash
node materialize-openclaw-model-catalog.js /external/new-targets.json /external/existing-targets.json
```

After updating the native executor to 2.4.0, regenerate the native CLI catalogue
first, using `materialize-openclaw-catalog.js` and the accepted profiles. Pass
that fresh catalogue as `/external/existing-targets.json` to the model
materializer. It preserves native entries verbatim, so running only the model
materializer leaves their previous availability and pins unchanged. Stale
executor pins prevent the broker from loading the catalogue, including its
isolated model entries.

This command reads the private OpenClaw gateway, preserves existing local/native
agent entries, and creates bounded, pinned model profiles outside Git. Fixed
routing, native billing and a current observation window are required. It does
not contact a provider or execute a model. Paid model execution retains the
existing signed SpendGrant plus the native per-request ceiling. Paid native
agent benchmarks, along with local and included agents, stay unavailable until
their native turn/spend boundary is qualified before execution. The agent
materializer reads native catalogue billing for cloud profiles beyond local and
included subscription profiles.

Direct OpenRouter execution, its provider key and its model-specific materializer
are retired. Historical results and their exact former provider/cost provenance
remain unchanged. Native SDK receipts identify the selected route, retain cache
usage and explicitly leave the served revision/upstream identity unobserved.
See [execution sources](../../docs/EXECUTION_SOURCES.md) for parameter limits and
migration validation.

To connect an installed broker, supply these external Benchmark Compose inputs:

```dotenv
BENCHMARK_HARNESS_ENABLED=true
AGENTX_BENCHMARK_HARNESS_URL=http://host.docker.internal:3091
```

Choose the actual private, reachable endpoint. A loopback-only native broker is
not automatically reachable from a Linux container; use the instance's existing
private proxy/network arrangement. Never expose the broker publicly. Its default
feature flag in AgentX is false. Keep the signing key on the broker, outside the
Benchmark container.

## Verification

`npm test --prefix integrations/benchmark-harness-broker` exercises synthetic
executors, claims, target pins, stream/cancellation bounds, spend isolation and
the installed-module catalog fixture. Windows skips the POSIX descendant-process
termination check; the existing Linux Core CI job runs it through integration
tests. These checks do not validate real GPU, native subscription or paid behavior.

When installing a new broker source, keep the accepted runtime/profile settings
and the audit/spend ledgers, repin and validate the external catalog in the order
above, then receive the installed availability and pins. Native agent cells stay
unavailable; real cells require a qualified route and its normal admission.
To back out, disable `BENCHMARK_HARNESS_ENABLED`, stop the broker and restore the
accepted pins without deleting receipts or spend history.
