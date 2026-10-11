# Hermes image specialist

Hermes runs alongside OpenClaw in its own profile. The specialist develops image
briefs and gives ComfyUI workflow advice. AgentX Core retains image generation,
GPU admission, recovery and the archive.

Install Hermes using its official installer, create a dedicated profile, configure
the reasoning provider on the host, and install the official optional `comfyui`
skill. Copy `skills/agentx-images` into that profile's skill directory. Keep its
credentials and runtime state outside this repository.
Deploy `worker.py` together with its sibling `text_policy.py`; the latter validates
Atelier lettering choices and supplies the bounded text-plan instructions.

`worker.py` accepts `{action: "consult", prompt, status}` or
`{action: "plan", request, status, actionKey}` on stdin. It serializes consultations
for the configured profile, bounds the Hermes run, and consumes the official
stream-JSON protocol. Planning returns text containing a JSON plan; the caller
validates the plan before submitting anything. A supplied native action key
retains the exact plan across retries and refuses a changed brief. Planning and
consultation expose skill tools, with no terminal or generation tool.
An optional `request.textPolicy` carries Atelier's checkbox, strategy and exact
labels. Enabled planning returns a `textPlan` alongside the visual prompt;
Core and the gateway validate it before application. Hermes preserves supplied
spelling and placements, recommends one or two passes for automatic mode and
never runs the second pass. Atelier adds those labels as editable browser layers
after a verified text-free image. Disabled text omits `textPlan`; exact-text
constraints conflict with this choice. Draft context carries the same policy
through consultations. See [the Atelier contract](../../docs/LOCAL_IMAGES.md).
Core planning requests include `renderBudget` with the canonical visual-description
limits for each available lettering strategy. The worker uses these limits instead
of its fallback reserve. The limits cover the current labels; additions or longer
placements consume extra space, and the actual returned plan is validated again.

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

Atelier accepts a working brief and consultation message up to 32,000 UTF-16
units each. The composed working brief includes its explicit constraints in that
budget. Hermes prepares a final render prompt within 8,000 units, including the
constraint block; applying remains an explicit user action. Core preserves the
full current input and removes only older complete history pairs when necessary
to fit the installed Studio transport bounds. If the current envelope alone is
too large, it refuses before saving a turn or invoking Hermes. The native imageX
tool retains its existing 8,000-unit input contract.

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

When the instance runs the official `hermes dashboard`, set `HERMES_PUBLIC_URL`
to its browser-facing URL (including any reverse-proxy prefix). Atelier shows
an external management link with the `imagex` profile selected. Its fallback is
`HERMES_DASHBOARD_URL`; no credentials or query tokens enter the link. Hermes
retains its native authentication and profile management. The Atelier's saved
conversations remain in Core; Hermes's dashboard shows native execution sessions.

Run `python3 -m unittest discover -s integrations/hermes/test` and
`npm test --prefix integrations/openclaw/imagex`, along with the personal harness
suite when changing its shared adapter. Installation, native tool availability,
reasoning-provider access and a completed restored image each need live checks.
