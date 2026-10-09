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
- `agentx-images starters` — the same editable brief starters offered in l’Atelier.
- `agentx-images list` — existing image operations; inspecting history submits nothing.
- `agentx-images create --key REQUEST_ID --profile PROFILE --prompt TEXT --width 1024 --height 1024`
  — one idempotent Core request. A request key belongs to that exact request.
- `agentx-images operation OPERATION_ID` — observe the existing operation.
- `agentx-images details OPERATION_ID` — recorded models, execution, lineage and timings.
- `agentx-images draft OPERATION_ID` — the saved prompt, dimensions and seed.
- `agentx-images download OPERATION_ID --output PATH` — verify completion,
  runtime restoration and SHA-256 before saving its archived image.
- `agentx-images export OPERATION_ID --output NEW_DIRECTORY` — download the
  recorded manifest, graph, original references, worker copies and output; every
  part must match its exact size and SHA-256 before publishing the directory.
  Export observes an existing operation; it neither imports nor executes a graph.

For editing, add `--parent-operation ID --parent-sha SHA256` to use a completed,
restored creation as reference 1. Add `--reference PATH` for a PNG/JPEG working
copy; at most two references total, in the supplied order. Preserve the actual
reference order in the prompt. If workshop reports a declared recipe identity,
pass its exact `--recipe-id ID --recipe-version VERSION` together.

After acceptance, return the operation ID and studio path and end the turn.
Observe later; never submit again under a new key to recover a lost reply.
Completed means Core reports `completed`, `runtimeRestored: true` and a verified
artifact. Report busy, refused, failed and unknown states accurately.

For a planning consultation, return only the requested plan. The caller submits
it after your Hermes process exits. Preserve explicit model/profile, dimensions,
subject, requested style, composition and reference order. Prefer concrete visual
descriptions. Keep reproducible recipe notes with profile, prompt, dimensions,
seed, operation ID and actual result, distinguishing tested findings from guesses.

## Exploration and learning

Core exposes creation, reference editing/composition, profiles, dimensions, seed,
history, saved details and verified export. It does not currently expose masks,
denoise controls, standalone upscaling, ControlNet, LoRA, arbitrary graph dispatch
or recipe import. Installed nodes alone are evidence for a possible experiment,
not for a live API capability. Reference edits can change unrequested areas;
seeds and exported recipes do not guarantee identical pixels.

When asked to expand capacity, inspect current workshop evidence first, propose
one bounded experiment, and use a synthetic reference when available. Submit
only through Core, with an exact request identity. Once accepted, end that turn;
observe the operation in a later turn. Record a learning note only after reading
the completed restored receipt, saved details and actual output. Record profile,
reference order, prompt, dimensions, seed, checksums, timing, observed strengths
and limitations. If visual inspection is unavailable, say so and record execution
evidence separately from visual quality. Keep notes and exports in the private
profile workspace. Never send private images or notes to a cloud vision provider
without explicit owner authorization for that content.
