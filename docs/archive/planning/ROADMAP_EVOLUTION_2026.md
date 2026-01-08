# Roadmap Evolution Proposal: Phase 2 (Q1 2026)

**Status:** PROPOSAL
**Based on:** [Peer Review Final Report](../PEER_REVIEW_FINAL_2026-01-04.md)
**Target:** Q1 2026

---

## 1. Strategic Shift

With the successful completion of the initial 6 development tracks (Alerts, Analytics, Custom Models, Self-Healing, Testing, Backup), the SBQC Stack (AgentX + DataAPI) has reached feature maturity.

However, the Peer Review conducted on Jan 4, 2026, identified a critical gap between **implementation reality** and **documentation claims**, alongside security and architectural technical debt.

**The Proposal:** Shift focus from "Feature Velocity" to **"Stabilization & Operational Excellence"**.

---

## 2. Proposed Development Tracks (Phase 2)

We propose four new tracks to replace the completed Tracks 1-6.

### Track 7: Documentation Integrity ("The Reality Check")
**Goal:** Eliminate "Documentation Drift" and ensure the repo is approachable for new operators.
*   **Immediate:**
    *   [ ] **AgentX README Overhaul:** Update version to 1.4.1, document actual SOA architecture, list all 6 completed tracks.
    *   [ ] **DataAPI README Fix:** Remove `dataapi.html` reference, clarify "Live Data" vs "Proxy" architecture.
    *   [ ] **Env Var Standardization:** Create comprehensive `.env.example` files with comments for every variable.
*   **Structural:**
    *   [ ] **Architecture Diagram:** Create `docs/ARCHITECTURE_REALITY.md` reflecting the actual PM2/Service topology.
    *   [ ] **Integration Guide:** Single source of truth for AgentX ↔ DataAPI ↔ n8n data flow.
*   **Process:**
    *   [ ] **Docs-as-Code:** Implement CI check to ensure `package.json` version matches `CHANGELOG.md`.

### Track 8: Security Hardening
**Goal:** Remediate critical security risks identified in peer review.
*   **Critical:**
    *   [ ] **Secret Rotation:** Rotate all API keys (`DATAAPI_API_KEY`, `OPENAI_API_KEY`).
    *   [ ] **Git Hygiene:** Remove `.env` files from history (BFG Repo-Cleaner) and enforce `.gitignore`.
*   **Hardening:**
    *   [ ] **Secret Management:** Transition from `.env` to a more secure injection method for production (or strict file permissions).
    *   [ ] **RBAC Audit:** Verify DataAPI role enforcement across all endpoints.

### Track 9: Architectural Refinement
**Goal:** Pay down technical debt and enforce the Service-Oriented Architecture (SOA).
*   **AgentX:**
    *   [ ] **Route Refactoring:** Move remaining business logic (e.g., RAG instantiation in `routes/api.js`) to services.
    *   [ ] **Utils Cleanup:** Consolidate `src/utils.js` and `src/utils/` into a single coherent module structure.
*   **DataAPI:**
    *   [ ] **Identity Crisis Resolution:** Officially decide if DataAPI is "Headless" (remove views) or "Hybrid" (document UI).
    *   [ ] **Health Check:** Implement `/health` and `/health/detailed` endpoints matching AgentX standard.
*   **General:**
    *   [ ] **API Standardization:** Unify response envelopes (`{ status: 'success', data: ... }`) across both services.

### Track 10: Operational Maturity
**Goal:** Make the system robust, deployable, and recoverable.
*   **Deployment:**
    *   [ ] **Qdrant Automation:** Script the download/setup of Qdrant binary to match "Quick Start" claims.
    *   [ ] **Decoupled Ecosystem:** Split `ecosystem.config.js` to allow independent service deployment.
*   **Resilience:**
    *   [ ] **Rollback Strategy:** Document and script a "Panic Button" rollback procedure.
    *   [ ] **Self-Healing UI:** Implement the missing "Approval Workflow" UI for critical self-healing actions.

---

## 3. DataAPI Specific Evolution

DataAPI requires a specific sub-roadmap to clarify its role in the stack.

*   **Q1 Goal:** Solidify role as "The Data Utility Belt" for AgentX.
*   **Action:** Rename "Live Data" to "Data Services" to encompass both background ingestion (ISS, Quakes) and on-demand proxies (Tides, Weather).
*   **Action:** Formalize the n8n contract: "AgentX triggers workflows; DataAPI logs events."

---

## 4. Execution Plan

1.  **Week 1 (The "Cleanup"):**
    *   Execute **Track 8 (Security)** immediately.
    *   Apply **Track 7 (Docs)** fixes to READMEs.
2.  **Week 2-3 (The "Refactor"):**
    *   Address **Track 9 (Architecture)** items (Utils split, Route logic).
3.  **Week 4+ (The "Hardening"):**
    *   Implement **Track 10 (Ops)** improvements (Qdrant scripts, Rollback).

---

## 5. Decision Required

*   **Approve Phase 2 Tracks?**
*   **DataAPI Direction:** Headless vs. Hybrid? (Recommendation: Hybrid, but document it clearly).
