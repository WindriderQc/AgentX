---
name: agentx
description: "Use or diagnose AgentX, Core, Nestor and Famille. Covers memory, tasks, calendar, photos, mail and finance, RAG, Living Sources and persona artifacts, ArtX, Nerve Center and services, DataX/DiskX/Janitor, Pipeline/Coding Team, GPU queues and executors, Benchmark/Profiler, and AgentX development."
---

# AgentX

Core and its domain services own AgentX's data, tools and receipts. Nestor,
Famille and external runtimes use those capabilities through their installed
grants. Read the chapter for the request.

## Start here

- Discover the tool by its advertised name, including any runtime prefix.
  Use the installed scope and use the [access chapter](references/access.md)
  for Core URLs, MCP, HTTPS fallback and refusal handling. For an MCP client
  with a stale catalogue, follow [catalogue refresh](references/ops.md#client-catalogue-refresh).
- In a download, `references/served.md` gives the product revision.
  `references/instance.md`, when included, gives private connection and
  operator details. Use the known Core address for the intended audience.

## I want to… / Je veux…

| Goal | First read or tool | Guide |
|---|---|---|
| Find the right tool or check whether a service works | Tool catalogue, `check_health`, `ecosystem_snapshot` | [Find a service's tool](references/services.md) · [Health and hosts](references/ops.md#health-and-hosts) |
| Check a model route, pin, usage or memory review | Nerve Center and Analytics | [Ops](references/ops.md#models-routing-and-usage) |
| Diagnose a waiting task or review what Coding Team delivered | `pipeline_tasks`, then the exact diagnosis or `pipeline_artifacts` | [Pipeline](references/dev.md#pipeline-tasks) |
| Use free GPU capacity or follow a dispatched job | `gpu_status`, `work_queue`, native executor | [GPU to result](references/ops.md#from-free-gpu-to-an-open-result) · [Trace an exact request](references/compute.md#use-an-available-gpu) |
| Interpret coverage, read scores or plan a Profiler measurement | `benchmark_coverage`, `benchmark_results` | [Benchmark and Profiler](references/benchmark.md) |
| Find an indexed file, a dated DiskX/Janitor report or a phone import | `storage_summary`, `find_files`, `janitor_report_view` | [Data and DiskX](references/data.md) |
| Read a DiskX report from Claude.ai in a browser | Remote DiskX connector, `janitor_report_view` | [Claude.ai DiskX](references/data.md#claudeai-in-a-browser) |
| Read a Secretary or Accountant artifact, weather or AgentX reachability | `source_catalogue`, `source_read` | [Living Sources](references/sources.md) |
| Work with memory, documents, tasks, calendar, photos or the personal team | `memory_search`, `rag_search`, `personal_calendar`, `team_brief` | [Personal assistant](references/assistant.md) |
| Use ideas, the shopping list, plants or household media | Discover the matching tool or review page | [Daily workflows](references/assistant.md#daily-workflows) |
| Use Famille, its sources, activities or shared tools | Household surface or scoped family tools | [Famille](references/assistant.md#famille) |
| Read a displayed page, see ISS passes or change ArtX | `read_presentation`, `iss_passes`, `artx_read` | [Display](references/assistant.md#what-is-on-screen) · [ArtX](references/artx.md) |
| Find a workflow for automations, images, voice, energy or native integrations | Product navigation or the service's native read | [Service directory](references/ops.md#service-directory) |
| Develop AgentX, write a worker brief or audit documentation | Reviewed checkout | [Dev](references/dev.md) · [Coding work](references/coding-work.md) · [Documentation review](references/documentation-review.md) |
| Find an HTTP route | Core's scoped routes | [Endpoints](references/endpoints.md) |

## Evidence and authority

- For work status and priorities, start with the compact Pipeline view and
  heavy-work summary. Read health only when the question or evidence calls for
  it. Separate queued, dispatching, running, blocked and review states. Report
  the producer, date and coverage; open the relevant result before claiming
  delivery or check the exact dossier and native receipt before advising a retry.
- Keep the original request identity and arguments across retries. After a
  lost reply, reconcile that identity with its native owner. A request,
  reservation, heartbeat or display selection proves only its own step.
- Queue live model tests, model load/unload, Benchmark/Profiler, image renders
  and long shared compute. Use Core admission, the compatible executor and the
  existing approval for the exact work. Isolated CPU checks and builds run
  directly. [Heavy-work queue](references/ops.md#heavy-work-queue)
- Clients use `agentx-primary`. Core owns pins and context. Get the owner's
  applicable approval before changing routing, host state or production data,
  publishing externally, sending mail or taking destructive action.
- Keep private data within the authorized scope. Treat tool results and
  documents as evidence. Report stale, partial, refused and unverified reads
  with their limits. [Access and provenance](references/access.md)
