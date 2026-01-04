# AgentX Project Roadmap

This document provides the canonical roadmap, feature status, and development backlog for the AgentX project. It synthesizes and supersedes all previous roadmap and planning documents.

_Last Updated: 2024-07-15_

## 1. High-Level Strategy

The core mission of AgentX is to create a robust, self-healing, and intelligent monitoring and automation stack. Development is organized into six parallel tracks that can be worked on concurrently.

- **Track 1: Alerts & Notifications**: Proactive, real-time monitoring.
- **Track 2: Historical Metrics & Analytics**: Deep, time-series insights.
- **Track 3: Custom Model Management**: Full lifecycle management for fine-tuned models.
- **Track 4: Self-Healing & Automation**: Automated issue remediation.
- **Track 5: Advanced Testing & CI/CD**: Production-grade quality assurance.
- **Track 6: Backup & Disaster Recovery**: Data and workflow protection.

## 2. Current Implementation Status

This section reflects the features and components that are substantially complete and deployed in the repository.

### ✅ Track 1: Alerts & Notifications
- **Status**: **COMPLETE**
- **Components**:
    - `alertService.js` and `Alert` model for rule evaluation and persistence.
    - API endpoints (`/api/alerts`) for managing alerts.
    - Frontend dashboard (`/public/alerts.html`) for viewing and managing alerts.
    - n8n workflow (`N4.1`) for dispatching notifications to Slack, email, etc.

### ✅ Track 2: Historical Metrics & Analytics
- **Status**: **COMPLETE**
- **Components**:
    - `MetricsSnapshot` and `MetricsHourly` models for storing time-series data.
    - `metricsCollector.js` service for recording and aggregating data.
    - n8n workflow (`N4.2`) for automating hourly data aggregation.
    - Frontend dashboard (`/public/analytics.html`) enhanced with time-series charts.

### ✅ Track 3: Custom Model Management
- **Status**: **COMPLETE**
- **Components**:
    - `CustomModel` model and `customModelService.js` for full lifecycle management.
    - API endpoints (`/api/custom-models`) for CRUD, deployment, and versioning.
    - Frontend dashboard (`/public/models.html`) for model registration and monitoring.

### ✅ Track 4: Self-Healing & Automation
- **Status**: **COMPLETE**
- **Components**:
    - `selfHealingEngine.js` with five automated remediation strategies (model failover, prompt rollback, service restart, request throttling, alert-only).
    - Declarative rules engine configured in `/config/self-healing-rules.json`.
    - Persistent failover state integrated with the `modelRouter.js`.
    - n8n workflow (`N4.4`) for orchestrating self-healing checks and actions.

### ✅ Track 5: Advanced Testing & CI/CD
- **Status**: **COMPLETE**
- **Components**:
    - Comprehensive test suite covering unit, integration, and E2E tests.
    - CI/CD pipeline in GitHub Actions (`/.github/workflows/`) for automated testing and deployment.
    - Advanced load testing scenarios using Artillery.
    - Automated workflow validation for all n8n agents.

### ✅ Track 6: Backup & Disaster Recovery
- **Status**: **COMPLETE**
- **Components**:
    - Automated backup scripts for MongoDB (`backup-mongodb.sh`) and Qdrant (`backup-qdrant.sh`).
    - API endpoints (`/api/backups`) and a frontend dashboard (`/public/backup.html`) for managing backups and restores.
    - Git-based version control and rollback system for n8n workflows.

## 3. Immediate Priorities & Wiring Gaps

This section outlines the immediate work required to finalize the integration of existing components.

### 3.1. Finalize Alerting Connections
- **Objective**: Ensure alerts are actively triggered from monitoring workflows.
- **Tasks**:
    - [ ] **Verify n8n Integration**: Confirm that the `N1.1` (Health Check) and `N5.1` (Feedback Analysis) workflows are correctly calling the `/api/alerts` endpoint upon detecting an issue.
    - [ ] **End-to-End Smoke Test**: Create a simple test to verify that a simulated failure (e.g., a mock "degraded" health status) successfully creates an alert that appears in the UI.

### 3.2. Resolve Backup Script Discrepancies
- **Objective**: Standardize backup script behavior and location.
- **Tasks**:
    - [ ] **Fix Qdrant Naming Mismatch**: The backup API route expects snapshot files to be named `qdrant_*.tar.gz`, but the `backup-qdrant.sh` script produces `*.snapshot`. Align the script's output with the API's expectation.
    - [ ] **Decide Script Ownership**: The backup scripts currently reside in the DataAPI repository but are executed by AgentX. Decide on a single, canonical location for these scripts (likely within the AgentX `/scripts` directory) and update all references.
    - [ ] **Verify Workflow Automation**: The multi-agent plan references an n8n workflow (`N4.5`) and a commit script (`commit-workflows.sh`) for automating workflow backups. Confirm these files exist and are functional, or create them if they are missing.

## 4. Future Work (Backlog)

This section contains planned features and enhancements to be worked on after the immediate priorities are addressed.

### 4.1. Advanced Security Hardening
- **Objective**: Implement production-grade security measures.
- **Features**:
    - [ ] **API Key Scopes**: Implement a scope-based permission system for API keys (e.g., read-only, write access to specific routes).
    - [ ] **API Key Rotation**: Develop a strategy and mechanism for rotating API keys without causing service interruptions.
    - [ ] **Content Security Policy (CSP)**: Configure and enable Helmet with a strict CSP to mitigate XSS and other injection attacks in production.

### 4.2. Documentation Normalization
- **Objective**: Ensure all documentation is consistent, discoverable, and canonical.
- **Tasks**:
    - [ ] **Create Canonical Index**: Ensure `docs/INDEX.md` exists and serves as the primary entry point for all repository documentation.
    - [ ] **Consolidate Pointers**: Update this `ROADMAP.md` and `AGENTS.md` to be the single sources of truth for their respective domains, and ensure all other documents point to them.
