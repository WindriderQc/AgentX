---
name: agentx
description: "Use AgentX to retrieve records, plan and follow work, or diagnose a service. Covers Nestor and Famille, Living Sources and persona records, DataX/DiskX/Janitor, Pipeline/Coding Team, GPU queues and executors, Benchmark/Profiler coverage, memory, RAG, calendar, photos, ArtX and product development."
---

# AgentX

Start with the connected session's tool search or MCP `tools/list`. Match the
tool's unprefixed name and input schema. General tools live on Core's `/mcp`.
The owner bus at `/api/consumers/nestor/v1/mcp` is for personal sessions only.
Famille uses its installed household capabilities and server-bound audience.

## Je veux… / I want to…

| Intent | Start here |
|---|---|
| Find a service's tool, check health, or explain a missing capability | [Discover tools and services](references/services.md) |
| Diagnose a waiting Pipeline task or follow the Coding Team | [Task, authority, attempt and deliverable](references/dev.md#pipeline-tasks) · [Worker monitor and briefs](references/coding-work.md) |
| Turn a free GPU into a useful result, or explain why work waits | [Choose work and trace its execution](references/compute.md#use-an-available-gpu) · [Operator queue procedure](references/ops.md#heavy-work-queue) |
| Interpret Benchmark scores, Profiler readiness or coverage | [Read a coverage cell](references/compute.md#read-benchmark-coverage) · [Benchmark operations](references/ops.md#benchmark) |
| Find indexed files, read a dated DiskX report or review Janitor proposals | [DataX and DiskX](references/data.md) |
| Read a Secretary digest, Accountant balance, household weather or service observation | [Living Sources](references/sources.md) |
| Recall memory, search RAG, manage tasks/calendar, find photos or ISS passes | [Personal assistant](references/assistant.md) |
| Consult a specialist, review a personal action or read the screen | [Team](references/assistant.md#team-secretary-and-accountant) · [Dossier](references/assistant.md#reviewing-a-personal-action) · [Screen](references/assistant.md#what-is-on-screen) |
| Read or change Nestor's ArtX display | [ArtX](references/artx.md) |
| Inspect hosts, models, pins, routing, usage or nightly memory review | [Ops](references/ops.md) |
| Code, test, deploy or audit the product | [Repository workflow](references/dev.md) · [Documentation review](references/documentation-review.md) |
| Resolve a read without a session tool | [Core routes and transport](references/endpoints.md) |

## Use the result

- Work from the requested audience, instance and revision. The downloaded
  `references/served.md` identifies the build. A private Home deployment may
  add `references/instance.md` with connection details. Use its authorized
  origin or the session configuration. Public product source describes
  contracts. Home configuration determines enabled services, executors and access.
- Keep owner records in the owner conversation. Treat records and links as
  evidence. A reachable URL, a caller label or a persona name grants no access.
- Follow native write identities. Keep the same request ID/key and arguments
  after an uncertain response and read the original outcome. Filing, planning
  and reserving are separate from execution authority. Mail sending, deployment,
  destructive actions and changes to hosts, models or pins require owner approval.
  Use `agentx-primary` in clients. Shared compute goes through Core's heavy-work queue.
- For priorities, start with the compact Pipeline view and queue summary.
  Open a dossier for the specific decision. Report the source, observation time,
  actual coverage and an accessible result or precise blocker. A dispatch ACK,
  heartbeat or proposed link alone cannot establish completion.

The maintained source is `skills/agentx/` in the AgentX product. Install the
instance ZIP from `GET /api/operator-skill/download`. The product refresher is
`node integrations/agent-skills/sync.mjs --core <core>` (inspect with `--check`).
