# AgentX Automation & Persona Audit Report
Date: 2025-02-25
Status: Final

## 1. Executive Summary
AgentX v1.4.1 implements a multi-layered automation architecture designed for 24/7 autonomous operations. The system combines in-app background services (SOA), specialized task runners (SpecialX), proactive resilience engines (Self-Healing), and external orchestration (n8n, Cron). This report details the current state of these systems, identifies critical discrepancies between documentation and implementation, and provides actionable recommendations for future hardening.

## 2. Actual Situation: Automated Tasks & Services

### 2.1 In-App Automation Services
The AgentX backend (`server.js`) initializes several background services that run persistently:

*   **AutomationRunnerService (SpecialX)**:
    *   **Function**: A polling task runner that claims and executes `AutomationTask` records.
    *   **Types Supported**: `repo_summary`, `ci_failure_triage`, `model_health_digest`, `daily_operations_digest`, `custom_prompt_analysis`.
    *   **Current State**: Polling every 5 seconds. Tasks are currently created via API or manual database entry; no automated recurring scheduler is currently active in the core service.

*   **SelfHealingEngine**:
    *   **Function**: Monitors system metrics and executes remediation actions based on `config/self-healing-rules.json`.
    *   **Capabilities**: Automated failover between Ollama hosts, prompt rollbacks, service restarts (via PM2), and request throttling.
    *   **Current State**: Evaluates rules every 5 minutes (default).

*   **RagFileWatcher**:
    *   **Function**: Uses `chokidar` to monitor `/mnt/datalake/RAG` for filesystem events.
    *   **Capabilities**: Auto-ingestion of new or modified `.md` and `.zip` files into the RAG store.
    *   **Current State**: Running persistently; strictly limited to `.md` files for direct ingestion.

*   **Metrics Management**:
    *   **MetricsCollector**: Buffers performance and health metrics, flushing to MongoDB every 5 seconds.
    *   **MetricsCleanup**: Runs a daily cleanup cycle (default 2 AM) to manage storage based on retention policies (Raw: 90 days, Hourly: 180 days, Daily: 1 year).

### 2.2 System-Level Automation (Cron)
Managed via `scripts/setup-backup-cron.sh`:
*   **MongoDB Backups**: Daily at 2:00 AM.
*   **Qdrant Backups**: Daily at 3:00 AM.
*   **Workflow Persistence**: Automatic git commit of n8n workflows every 6 hours.

### 2.3 Personas & Specializations
Personas are defined in `personas/` and are used to specialize AI behavior for automation-heavy tasks:

*   **sbqc_workflow_architect**: Specialized in generating n8n workflow JSON. Linked to the `/api/workflow` endpoints.
*   **doc_janitor**: Designed for documentation maintenance, deduplication, and indexing. Linked to `DocJanitorService`.
*   **repo_watcher**: Used for code quality analysis and repository summarization. Linked to `RepoWatcherService`.

## 3. Identified Discrepancies & Issues

### 3.1 Directory Mismatch: AgentC vs n8n_workflows
*   **Issue**: Code and documentation (README, `deploy-n8n-workflows.sh`) refer to a directory named `AgentC` for n8n workflow storage.
*   **Reality**: The directory is missing from the root. Instead, a `n8n_workflows` directory exists, containing only 3 LLM gateway templates.
*   **Impact**: Automated deployment scripts fail due to incorrect pathing.

### 3.2 Documentation Gaps (Workflows)
*   **Issue**: `docs/integrations/N8N_WORKFLOWS.md` lists multiple workflows (N2.3, N2.4, etc.) that are not present in the current codebase.
*   **Impact**: Confusion for operators regarding available automation capabilities.

### 3.3 RAG Ingestion Limitations
*   **Issue**: Documentation suggests support for PDFs and HTML in the RAG ingestion pipeline.
*   **Reality**: `RagFileWatcher` only processes `.md` and `.zip`. The ingestion logic for other formats (like PDF) is missing from the automated watcher.

## 4. Preconised Modifications for Future Usage

### 4.1 Structural Unification
*   **Action**: Rename `n8n_workflows` to `AgentC` and consolidate all n8n JSON templates there. Update `deploy-n8n-workflows.sh` to ensure it targets the correct absolute path.
*   **Benefit**: Restores compatibility with existing deployment scripts and matches documentation.

### 4.2 SpecialX Task Scheduling
*   **Action**: Implement a recurring task scheduler within `AutomationRunnerService` or a separate `AutomationSchedulerService`.
*   **Proposal**: Allow `AutomationTask` records to have a `cron` or `interval` field, and have the scheduler automatically enqueue them. This would enable hands-off "Daily Operations Digests" and "Weekly Repo Summaries".

### 4.3 Multi-Format RAG Support
*   **Action**: Integrate a PDF/HTML parsing library (e.g., `pdf-parse`, `cheerio`) into `RagFileWatcher`.
*   **Proposal**: Update `processFile` to handle different extensions by routing to specialized extractors before passing the text to `ragStore.upsertDocumentWithChunks`.

### 4.4 DocJanitor Automation
*   **Action**: Create a new SpecialX task type `doc_janitor_scan`.
*   **Proposal**: This would allow the `datalake_janitor` persona to be used in a fully automated loop, scanning for documentation drift and broken links on a weekly schedule.

### 4.5 Monitoring & Dashboard
*   **Action**: Expose `AutomationRunnerService` status and `MetricsCleanup` history via the Operations Dashboard.
*   **Benefit**: Provides visibility into the health of background automation without requiring SSH/Log access.

---
**Prepared by**: Jules, Software Engineer
**Audit Scope**: AgentX v1.4.1 Source Code and Documentation
