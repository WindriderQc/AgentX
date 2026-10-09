# Hermes image specialist

Hermes runs alongside OpenClaw in its own profile. The specialist develops image
briefs and gives ComfyUI workflow advice. AgentX Core retains image generation,
GPU admission, recovery and the archive.

Install Hermes using its official installer, create a dedicated profile, configure
the reasoning provider on the host, and install the official optional `comfyui`
skill. Copy `skills/agentx-images` into that profile's skill directory. Keep its
credentials and runtime state outside this repository.

`worker.py` accepts `{action: "consult", prompt, status}` or
`{action: "plan", request, status, actionKey}` on stdin. It serializes consultations
for the configured profile, bounds the Hermes run, and consumes the official
stream-JSON protocol. Planning returns text containing a JSON plan; the caller
validates the plan before submitting anything. A supplied native action key
retains the exact plan across retries and refuses a changed brief. Planning and
consultation expose skill tools, with no terminal or generation tool.

Configure `HERMES_BIN`, `IMAGEX_PROFILE` and `IMAGEX_HOME` in the host wrapper.
The profile needs `config.yaml` and a `workspace/` directory. Configure `AGENTX_URL`
for `images.py`, which provides current status, workshop inspection, idempotent
creation, operation observation and SHA-verified image download. It never retries
mutations. Download refuses incomplete operations and existing output files.
The client also reads history, saved drafts/details and l’Atelier's six brief
starters. `export ID --output NEW_DIRECTORY` verifies and saves the recorded
manifest, graph, references and output without dispatching anything. A missing
historical export or mismatched part refuses the entire bundle. Export contains
the original reference bytes and metadata; store it with the image's privacy.

L’Atelier offers the same editable starters for illustration, product photography,
short lettering, targeted editing, two-image composition and variations. Applying
a starter replaces only the brief, preserving the selected references, profile,
format and seed. It does not submit a generation. Profile suggestions resolve
against the current workshop by model family, without pinning an instance model.

The optional `integrations/openclaw/imagex` plugin registers the private owner
`imagex` tool: consult, create, profiles, status and cancel. Its image operations
reuse the existing conversation scope, native identities and media delivery
adapter. The specialist chooses only configured profiles and preserves explicit
profile/dimension requests. The existing `local_image` path remains available.

The Atelier embeds imageX chat, editable brief proposals, an operational console
and a read-only profile document viewer. Hermes advises; AgentX owns canonical
`image-workshop` conversations, idempotent turn acceptance and image operations;
ComfyUI renders locally. Apply a proposal explicitly, then use the normal creation
button. Applying preserves the recipe, format, seed and reference selections.
Changed draft context blocks stale application. Images retain a server-verified
link to the completed proposal, including whether its prompt was edited.

Core uses its existing `OPENCLAW_GATEWAY_URL` and server-only
`OPENCLAW_GATEWAY_TOKEN` to call the plugin's gateway-authenticated
`POST /api/agentx/imagex/studio` route. The worker wrapper must forward `"$@"`;
`--events` exposes bounded JSONL operational events while the default native
tool protocol remains JSON. Only tool names and durations leave the worker;
tool arguments, outputs and stderr are excluded. A restart marks an unfinished
consultation interrupted and never repeats inference automatically.

Read-only `describe` and `resource` actions disclose selected model configuration
and five allowlisted documents: SOUL, the AgentX and ComfyUI skills, the capability
notebook and specialist memory. They exclude credentials/config file contents,
arbitrary paths, oversized files and links outside the profile. The dashboard
distinguishes configured routing from the model declared at Hermes startup;
that declaration does not attest an actual fallback. The consultation receives
bounded successful conversation history and current recipe evidence, with no
reference image bytes, private worker addresses or general owner conversations.
Vision inspection and profile editing are not offered by this surface.

Run `python3 -m unittest discover -s integrations/hermes/test` and
`npm test --prefix integrations/openclaw/imagex`, along with the personal harness
suite when changing its shared adapter. Installation, native tool availability,
reasoning-provider access and a completed restored image each need live checks.
