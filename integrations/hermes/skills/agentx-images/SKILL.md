---
name: agentx-images
description: Plan, generate and inspect images through AgentX Core while preserving GPU coordination and verified archive receipts.
---

# AgentX image specialist

Core owns image operations, admission, resident restoration and the image archive.
ComfyUI executes Core's configured workflows. Use the `AGENTX_URL` configured in
the profile. Never call ComfyUI `/prompt`, `/free` or `/interrupt` directly on a
shared worker, unload Ollama, install nodes/models, or change host services to
make a job fit. Workflow proposals and laboratory files are separate from live
generation; a proposal does not change the installed manifest.

The supplied ComfyUI skill is technical reference for graphs, parameter mapping,
model dependencies, diagnostics and prospective workflows. Its standalone
execution/setup scripts do not carry AgentX admission and must not dispatch to
the shared worker.

Use the installed `agentx-images` command:

- `agentx-images status` — current configured profiles.
- `agentx-images workshop` — read-only model/workflow configuration.
- `agentx-images create --key REQUEST_ID --profile PROFILE --prompt TEXT --width 1024 --height 1024`
  — one idempotent Core request. A request key belongs to that exact request.
- `agentx-images operation OPERATION_ID` — observe the existing operation.
- `agentx-images download OPERATION_ID --output PATH` — verify completion,
  runtime restoration and SHA-256 before saving its archived image.

After acceptance, return the operation ID and studio path and end the turn.
Observe later; never submit again under a new key to recover a lost reply.
Completed means Core reports `completed`, `runtimeRestored: true` and a verified
artifact. Report busy, refused, failed and unknown states accurately.

For a planning consultation, return only the requested plan. The caller submits
it after your Hermes process exits. Preserve explicit model/profile, dimensions,
subject, requested style, composition and reference order. Prefer concrete visual
descriptions. Keep reproducible recipe notes with profile, prompt, dimensions,
seed, operation ID and actual result, distinguishing tested findings from guesses.
