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

The optional `integrations/openclaw/imagex` plugin registers the private owner
`imagex` tool: consult, create, profiles, status and cancel. Its image operations
reuse the existing conversation scope, native identities and media delivery
adapter. The specialist chooses only configured profiles and preserves explicit
profile/dimension requests. The existing `local_image` path remains available.

Run `python3 -m unittest discover -s integrations/hermes/test` and
`npm test --prefix integrations/openclaw/imagex`, along with the personal harness
suite when changing its shared adapter. Installation, native tool availability,
reasoning-provider access and a completed restored image each need live checks.
