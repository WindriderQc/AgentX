# Documentation Mapping

**Purpose:** Map working, historical, and source-only docs to their canonical permanent destinations.

## Canonical Hubs

| Canonical Doc | Owns | Pulls From |
|---------------|------|------------|
| [`README.md`](/home/yb/codes/AgentX/README.md) | Public project entry point | `docs/INDEX.md`, onboarding, backend overview |
| [`docs/INDEX.md`](/home/yb/codes/AgentX/docs/INDEX.md) | Documentation navigation | All permanent doc areas |
| [`docs/architecture/backend-overview.md`](/home/yb/codes/AgentX/docs/architecture/backend-overview.md) | Runtime architecture and code-shape summary | `AGENTS.md`, `src/app.js`, service and route inventory |
| [`docs/user-manual/README.md`](/home/yb/codes/AgentX/docs/user-manual/README.md) | UI and operator workflows | `public/*.html`, `public/js/components/nav.js` |
| [`docs/architecture/README.md`](/home/yb/codes/AgentX/docs/architecture/README.md) | Architecture topic map | Architecture docs and stack docs |
| [`docs/operations/README.md`](/home/yb/codes/AgentX/docs/operations/README.md) | Ops/runbook entry point | Permanent operations docs |
| [`docs/testing/README.md`](/home/yb/codes/AgentX/docs/testing/README.md) | Testing entry point | Patterns, E2E README, load README |
| [`tests/e2e/README.md`](/home/yb/codes/AgentX/tests/e2e/README.md) | E2E suite navigation | Current quickstart/setup/test guides |

## Source-Only Or Working Docs

These remain useful but are not the permanent system-of-record:

| Doc / Group | Disposition | Canonical Home |
|-------------|-------------|----------------|
| `openclawPlan_v2.md` | Keep as active working plan | Referenced by consolidation docs; not part of permanent doc hub |
| `openclaw_Architecture.md` | Keep as ecosystem reference, non-canonical | Permanent OpenClaw relationship summarized in backend overview and user manual |
| `docs/future/*` | Keep as forward-looking design docs | Not part of the permanent operational path |
| `docs/plans/BENCHMARK_QUALITY_PLAN.md` | Keep as active benchmark plan | `docs/operations/BENCHMARK_SYSTEM.md` remains the live behavior doc |
| `reports/*.md` | Keep as generated reports for now | Mentioned as reports, not treated as permanent docs |

## Information Promoted Into Permanent Docs

| Source Material | Information Kept | Destination |
|-----------------|------------------|-------------|
| `AGENTS.md` | Middleware ordering, singleton pattern, architecture conventions | `docs/architecture/backend-overview.md` |
| `openclawPlan.md` / `openclaw_Architecture.md` | Three-plane framing: OpenClaw / AgentX / DataAPI | `docs/architecture/backend-overview.md`, `docs/user-manual/README.md` |
| `public/js/components/nav.js` | Real nav groups and live pages | `docs/user-manual/README.md`, `docs/consolidation/04-FRONTEND-UI.md` |
| `src/app.js` | Mounted API families and middleware order | `docs/architecture/backend-overview.md` |
| Historical SBQC validation docs | Kept only as historical references | `docs/archive/README.md` |

## Archive Mapping

| Archived Doc | Why It Moved | Archive Location |
|--------------|--------------|------------------|
| `openclawPlan.md` | Superseded by `openclawPlan_v2.md` | `docs/archive/2026-03-21/root/` |
| `docs/operations/BUG_FIX_HANDOFF.md` | One-time implementation handoff | `docs/archive/2026-03-21/operations/` |
| `docs/operations/START_BUG_SQUAD.md` | Temporary prompt/handoff doc | `docs/archive/2026-03-21/operations/` |
| `docs/architecture/SBQC-Stack-Final/00-AUDIT-SUMMARY.md` | Historical audit artifact | `docs/archive/2026-03-21/architecture/SBQC-Stack-Final/` |
| `docs/architecture/SBQC-Stack-Final/AGENT-PROMPT-FOR-VALIDATION.md` | Historical validation prompt | `docs/archive/2026-03-21/architecture/SBQC-Stack-Final/` |
| `docs/architecture/SBQC-Stack-Final/SETUP-SUMMARY-2025-12-31.md` | Dated setup summary | `docs/archive/2026-03-21/architecture/SBQC-Stack-Final/` |
| `docs/architecture/SBQC-Stack-Final/VALIDATION-REPORT-2025-12-31-1622.md` | Dated validation report | `docs/archive/2026-03-21/architecture/SBQC-Stack-Final/` |
| `tests/e2e/TEST_SUMMARY.md` | Historical detailed summary | `docs/archive/2026-03-21/testing/e2e/` |
| `tests/e2e/EXPORT_IMPORT_TEST_SUMMARY.md` | Historical detailed summary | `docs/archive/2026-03-21/testing/e2e/` |
| `tests/e2e/IMPLEMENTATION_REPORT.md` | Historical implementation report | `docs/archive/2026-03-21/testing/e2e/` |

