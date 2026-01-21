# repoWatcher Persona Plan

## Overview
repoWatcher is a local repository guardian that continuously scans a working folder, detects structural and content anomalies, and reports status with clear explanations. It is designed to monitor an AI-agent-heavy repo where changes can be inconsistent or fragmented, and where human maintainers want rapid feedback on quality drift.

## Goals
- Detect duplication (documents, code, assets) and report likely sources.
- Detect architecture disruption (unexpected file moves, missing critical paths, breaking folder conventions).
- Detect documentation inconsistencies/incoherence and missing docs.
- Detect missing tests (and later, failing tests in phase 2).
- Provide actionable, prioritized reports every 2-5 minutes.

## Non-goals
- Full semantic code review or performance optimization.
- Replacing CI or full test suites (phase 2 can trigger CI).
- Broad security scanning (can be added later as a separate module).

## Alignment with AgentX Conventions (CLAUDE.md)
- **Personas live in PromptConfig**: if repoWatcher is a persona, define `personas/repo_watcher.json` (snake_case name), seed it, and select via `options.persona`.
- **Prompt versioning + snapshots**: keep `name`, `version`, and `trafficWeight` consistent with existing prompt config practices for analysis.
- **Service-oriented architecture**: if repoWatcher becomes an AgentX API feature, routes stay thin and delegate to a service in `src/services/`.
- **Automation auth**: n8n calls to AgentX should use `x-api-key: ${AGENTX_API_KEY}` per integration docs.

## Inputs
- A local repo root (initially `/home/yb/codes/AgentX`).
- A configurable ruleset for allowed paths, file types, and critical documents.
- A persistent baseline (previous scan snapshots + metadata).

## Outputs
- Status: `ok | warn | fail`.
- Explanation list with evidence (file paths, diffs, confidence).
- Optional JSON payload for automation systems.
- Optional compact text summary for notifications.

## UI/UX Touchpoints (Existing)
- **Operations Center**: `http://localhost:3080/dashboard.html` for quick triggers and status.
- **n8n Monitor**: `http://localhost:3080/n8n-monitor.html` for workflow monitoring/testing.
- Add a lightweight status surface (latest report + severity) rather than a new UI surface.

## Architecture (High Level)
1. Local scanner service (repoWatcher) runs on a schedule.
2. It performs a filesystem scan and builds a snapshot.
3. It diffs against the previous snapshot.
4. It runs detection modules on the diff + current snapshot.
5. It emits a report to local log + optional webhook (n8n).

## Core Scan Pipeline
1. **Discovery**
   - Walk the repo, respecting ignore rules (e.g., `node_modules`, `dist`, `.git`).
   - Collect file metadata: path, size, mtime, type, hash (optional for large files).
2. **Snapshot**
   - Store structured metadata in a local state store (SQLite or JSON).
3. **Diff**
   - Compare current snapshot vs previous: added/removed/moved/changed files.
4. **Analyze**
   - Run detection modules that use diff + full snapshot.
5. **Report**
   - Output report with severity and explanation.

## Detection Modules (Phase 1)
1. **Document duplication**
   - Content hash match for text files (MD, TXT, HTML, etc.).
   - Similarity (optional): fuzzy match with thresholds.
2. **Code duplication**
   - Basic heuristic: identical blocks across files using a rolling hash.
   - Report duplicates with file segments + confidence.
3. **Architecture disruption**
   - Detect unexpected moves of critical directories.
   - Detect missing standard files (README, package.json, docs root).
   - Detect structural drift: new folders not in allowed patterns.
4. **Documentation inconsistencies**
   - Missing or inconsistent references between README/docs.
   - Stale or conflicting API docs (heuristic via section match).
5. **Missing tests**
   - Heuristic: file types in `src/` without matching tests in `tests/` or `__tests__/`.

## Detection Modules (Phase 2)
- **Failing tests** (trigger or read latest CI status).
- **Doc coherence** with embeddings/RAG and semantic diffs.

## Severity + Status Rules
- `fail`: critical path missing, massive duplication spike, architecture violation.
- `warn`: doc/test gaps, moderate duplication, conflicting doc sections.
- `ok`: no new high-impact findings.

## Reporting Format (Recommended JSON)
```json
{
  "timestamp": "2025-01-01T12:00:00Z",
  "repo": "/home/yb/codes/AgentX",
  "status": "warn",
  "summary": "3 warnings, 0 failures",
  "findings": [
    {
      "type": "missing_test",
      "severity": "warn",
      "path": "src/foo/bar.js",
      "evidence": "No matching test in tests/ or __tests__/",
      "confidence": 0.72
    }
  ]
}
```

## Scheduling Strategy
- Run every 2-5 minutes, jittered to avoid spikes.
- Optional manual trigger for immediate scan.
- Use a lock to avoid overlapping runs.

## State Storage
- `repoWatcher.state.db` (SQLite) or `repoWatcher.state.json`.
- Store: scan timestamps, file metadata, module outputs, last report.
- Keep rolling history for trend detection (e.g., duplication growth).

## n8n Workflow Fit (SBQC)
- Use SBQC naming for scanning: `SBQC - N2.x Repo Watcher` (N2 = data collection & scanning).
- Prefer the dual-trigger pattern (schedule + webhook) so Ops can run manual checks.
- Log findings to the DataAPI event sink (`/integrations/events/n8n`) with `continueOnFail: true`.
- Store workflow JSON alongside existing libraries (`AgentC/` or `n8n_workflows/`) for versioning.

## n8n Integration Options
1. **Local webhook push (recommended)**
   - repoWatcher runs locally, posts JSON to an n8n webhook.
   - Pros: no mount required, minimal n8n permissions.
   - Cons: n8n does not read files directly.
2. **Shared volume mount**
   - Run n8n on the same host and mount the repo root.
   - Pros: n8n can read files directly.
   - Cons: more complex setup, higher permissions.
3. **RAG folder sync**
   - repoWatcher writes normalized diffs to a designated folder.
   - n8n ingests those files (via file watch or scheduled read).
   - Pros: limited data surface, clear scope for ingestion.
   - Cons: requires ingestion logic on n8n side.
4. **Hybrid (AgentX + n8n)**
   - repoWatcher posts to n8n; n8n logs to DataAPI and optionally calls AgentX `/api/rag/ingest`.
   - Pros: aligns with existing n8n + RAG flows and centralized API auth.
   - Cons: more moving parts.

## Suggested First Implementation
- Build a local Node/Python watcher that:
  - Scans + diffs + detects.
  - Writes JSON report to `reports/repoWatcher/latest.json`.
  - Posts report to n8n webhook (optional).
- Add an `ignore` config file (e.g., `repoWatcher.ignore`) to keep false positives down.
- If using an LLM summary layer, create `personas/repo_watcher.json` and seed it via a script.

## Data Flow (Minimal)
1. Scan filesystem -> snapshot.
2. Diff -> detection modules.
3. Report -> local JSON + webhook.

## Common n8n JSON Pitfalls (Avoid)
- Connections must reference **node names**, not IDs.
- Webhook nodes need a `webhookId` that matches the path.
- n8n expressions must be quoted: `\"jsonBody\": \"={{ { \\\"key\\\": $json.value } }}\"`.
- Use `continueOnFail: true` for logging/notification nodes.
- Validate JSON before import; ensure node IDs are unique.

## Open Questions
- Which folders are considered "critical" for architecture?
- Preferred test naming conventions?
- Acceptable duplication thresholds (by file type)?
- Should repoWatcher respect `.gitignore` or a separate ignore file?
- Is a "report only" mode required for early rollout?

## Acceptance Criteria
- Can scan repo and produce report in under 30 seconds.
- Detects at least: missing tests, doc duplication, and structural drift.
- Provides stable output format for n8n ingestion.
- Low false positives in initial rollout.

## Next Steps
- Confirm detection thresholds and critical paths.
- Decide on n8n integration option (1-4).
- Create `repoWatcher.config.json` and a minimal CLI runner.
- Decide whether repoWatcher is a persona (PromptConfig) or a pure daemon + webhook.
