# Optional runtime bridges

This code is built into Core, enabled only with `AGENTX_PROFILE=full` and
`AGENTX_RUNTIME_BRIDGES_ENABLED=true`. Do not also install the old trusted
extension: that would register two owners for the same routes.

OpenClaw's Ollama protocol (`/api/openclaw-ollama`) and Hermes's OpenAI protocol
(`/api/hermes-openai`) delegate inference, admission, model/context policy and
host settlement to Core. The benchmark broker supplies exact claim metadata;
pipeline requests use Core task records and expiring attribution leases. Native
runtime configuration, accounts, histories and catalog files stay external.

## OpenAI-compatible gateway

`/api/llm/v1` is one OpenAI-compatible door for any client: `models`,
`chat/completions` and `responses`. A client sends the standard OpenAI API key
header, `Authorization: Bearer <token>`, and the token alone says which client
it is; a request without a known token gets 401. Every request then takes
Hermes's path through Core: the effective model policy, the `agentx-primary`
alias (the principal model with its host and pinned context, so a client never
loads a second copy), admission and InferenceLog. The client id is the caller
(`llm-gateway/<id>`) and the consumer contract (`<id>-gateway-v1`) that
analytics group by. Gateway clients never request household priority: Nestor's
conversations go first.

Clients are declared in the secret `AGENTX_LLM_GATEWAY_CLIENTS`, a JSON object
from client id to token, or to `{ "token", "admission" }`, for example
`{"codex-windows":"<random>","script":{"token":"<random>","admission":"immediate"}}`.
Give each device or tool its own token to see its load under its own name.
Tokens are unique and at least 16 characters. `patient` admission (the
default) waits up to eight minutes for a busy host, like Hermes's patient
route; `immediate` is refused at once. Invalid JSON fails startup. Hermes keeps
its own address, `/api/hermes-openai`, unchanged.

`responses` serves the stateless Responses API that OpenAI Codex uses
(`store: false`, full history in `input`); `previous_response_id` is refused.
Function tools are offered as is, tools in a `namespace` as `<namespace>__<name>`
and freeform `custom` tools as a function taking `input`; answers are mapped
back to the names Codex declared. Hosted tools such as `web_search` have no
local executor and are not offered. Images (`input_image` data URLs, also in
tool results) are sent to the model; other files are replaced by a short notice.
Reasoning streams as a reasoning summary. Core accepts at most 512 messages,
so a longer history folds its oldest turns into one text message.

Codex configuration (`~/.codex/config.toml`), with the client's token in the
environment variable named by `env_key`:

```toml
model_provider = "agentx"
model = "agentx-primary"
model_context_window = 196608
model_auto_compact_token_limit = 180000

[model_providers.agentx]
name = "AgentX"
base_url = "https://<core-address>/api/llm/v1"
wire_api = "responses"
env_key = "AGENTX_LLM_CODEX_TOKEN"
```

Set `model_context_window` to the principal route's context. Codex warns that
it has no metadata for `agentx-primary`; the warning is harmless.

Every door sends inline images to a model that reads them. When the routed
model does not, Core refuses before admission and the gateway asks OpenClaw
Main (below) to describe the images, then runs the request with that text in
their place (`X-AgentX-Images-Described: true`). Remote image URLs are refused.

Hermes can therefore send images directly to `/api/hermes-openai/v1`. Its
earlier image analysis route remains: `/api/hermes-openai/vision/v1` with model
`openclaw:agent:main`. The adapter sends inline image bytes to OpenClaw Main
through Core's existing agent execution source and returns only a verified
completed answer. Main's local model requests retain the OpenClaw-to-Core
admission and telemetry path. Vision requests never invoke the local Hermes
reasoning route.
The bounded worker exposes the `skills,vision` toolsets.

Configure the external Hermes profile's `auxiliary.vision` with this custom
endpoint, model and an empty fallback chain, and set `agent.image_input_mode`
to `text`. Hermes then asks Main to analyze attached images before using the
observations in its reasoning. The primary reasoning model remains an effective
local model through `/api/hermes-openai/v1`; its provider fallback list is owned
by Hermes. A fallback in reasoning does not change the vision endpoint.

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

A model that several uses share takes its reasoning from the use, not from its
name: a gateway provider that sends `x-agentx-think: off` (or `on`) in its
headers sets it for every turn of that provider, over the list above and over
the level the agent asked for. Another provider of the same model keeps its
own. Any other value is refused (400). Pipeline turns keep their level.

The operations projection, protected OpenClaw/DSH launchers, runtime config
export/validation and coding delivery inbox retain their existing HTTP contracts.
Historical `aio-ops-*` wire identifiers and old Product release receipt readers
remain compatible; they do not create another deployment or source repository.

Set private values through the external `AGENTX_ENV_FILE`; Compose forwards the
supported integration variables. Mount external inventories read-only through
`AGENTX_COMPOSE_OVERRIDE` and set `AGENTX_INSTANCE_ROOT` to their container path.
Its optional `config/agent-registry.yml`, `SCHEDULED.md` and old coordination evidence are read-only projection inputs.
Its optional `config/agent-ops-new-member.json` gives the agent runtime's entry
format to the Agent Ops new-member guide: `{ runtime, entryPath, entry, notes[] }`,
where `entry` may use `{{id}}`, `{{name}}` and `{{model}}` in keys and strings.
Without it, the guide prepares no runtime-specific entry.
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
