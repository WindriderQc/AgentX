# Optional runtime bridges

This code is built into Core, enabled only with `AGENTX_PROFILE=full` and
`AGENTX_RUNTIME_BRIDGES_ENABLED=true`. Do not also install the old trusted
extension: that would register two owners for the same routes.

OpenClaw's Ollama protocol (`/api/openclaw-ollama`) and Hermes's OpenAI protocol
(`/api/hermes-openai`) delegate inference, admission, model/context policy and
host settlement to Core. The benchmark broker supplies exact claim metadata;
pipeline requests use Core task records and expiring attribution leases. Native
runtime configuration, accounts, histories and catalog files stay external.

When the local host is refused (benchmark, maintenance, another resident model),
the OpenClaw protocol answers 409 so an automation records a failed run. A
conversation provider can instead send `x-agentx-busy-reply: conversation`: Core
then returns an ordinary assistant answer in French naming what holds the host
and since when, and nothing falls back to a cloud model. Declare it as a second
OpenClaw provider with the same `baseUrl` plus that header in `headers`, use it
for the conversational agent with an empty fallback list, and keep cron turns
on the plain provider. The provider names an exact model, not a Core task.
`OPENCLAW_CONVERSATION_FALLBACK_TASK` (for example `nestor_answer_light`) lets
that conversation borrow the task's fallback ladder: a busy, unreachable or
quarantined primary, or one that refuses before any output, sends the turn to
the first available rung, without tools or thinking, with the brain named in
the system prompt, a one-line notice ahead of the reply and `X-AgentX-Degraded*`
headers. An outcome that is unknown after dispatch, a partial stream or a
cancelled turn is never replayed. Unset, or with no rung available, the busy
reply remains. See docs/OPERATIONS.md for the ladder itself.

`OPENCLAW_CONVERSATION_HOSTS` (`model=http://host:11434`, comma-separated) sends
an OpenClaw conversation model to one configured inference host instead of the
routed task model, for example a second agent on a smaller GPU. The bridge sets
no `num_ctx`: Core applies that host's pinned context and keep-alive, so pin
the model on the host first or each turn may load it beside the resident one.

`OPENCLAW_CONVERSATION_NO_THINK_MODELS` (model names, comma-separated) makes the
listed conversation models answer without reasoning, whatever thinking level the
agent or session asks for. It suits a spoken lane, where reasoning delays the
first word; other models and Pipeline turns keep the level they were sent.

The operations projection, protected OpenClaw/DSH launchers, runtime config
export/validation and coding delivery inbox retain their existing HTTP contracts.
Historical `aio-ops-*` wire identifiers and old Product release receipt readers
remain compatible; they do not create another deployment or source repository.

Set private values through the external `AGENTX_ENV_FILE`; Compose forwards the
supported integration variables. Mount external inventories read-only through
`AGENTX_COMPOSE_OVERRIDE` and set `AGENTX_INSTANCE_ROOT` to their container path.
Its optional `config/agent-registry.yml`, `config/coding-dispatcher.json`,
`SCHEDULED.md` and old coordination evidence are read-only projection inputs.
Do not commit a copy here. SSH key/known-host mounts and remote paths are explicit
instance settings. Inventory SSH does not implicitly enable coding dispatch or
production probing.

Coding delivery defaults to this repository's `ci.yml` and the existing five CI
jobs. After merge, the operator uses the unified AgentX launcher. A deployed
receipt requires a clean checkout containing the merge, healthy active services
and matching `AGENTX_BUILD_REVISION` values from each container. Configure the
read-only probe using `CODING_DELIVERY_SSH_TARGET`, `CODING_DELIVERY_REMOTE_ROOT`,
`CODING_DELIVERY_ENV_FILE`, and optionally `CODING_DELIVERY_PROJECT_NAME` and
`CODING_DELIVERY_COMPOSE_OVERRIDE`. No push-to-deploy scheduler is installed.
The explicit legacy workflow/product readers are only for old receipts.

The coding dispatch API remains unavailable until an operator configures its
native backend, which lives in `integrations/coding`. Merely enabling these
bridges does not install or start it.

Portable tests live in `test/`; actual Express/Mongo wiring is tested in
`core/tests/integration/runtime-bridges.test.js`. Synthetic tests and Linux CI
do not establish live OpenClaw/Hermes, GPU, printer or coding acceptance.
