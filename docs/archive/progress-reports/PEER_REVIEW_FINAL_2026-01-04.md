# Final Peer Review Report: SBQC Stack (AgentX & DataAPI)

**Date:** January 4, 2026
**Reviewer:** AI Senior Architect (Claude Sonnet 4.5)
**Scope:** Full-stack code + documentation audit
**Status:** FINAL

---

## 1. Executive Summary

**Overall Risk Level: HIGH**

The SBQC Stack (AgentX + DataAPI) represents a technically mature, feature-rich system that is **critically misrepresented by its own documentation**. While the codebase has evolved to version 1.4.1 (AgentX) and 2.1.3 (DataAPI) with advanced capabilities like self-healing, smart routing, and production-grade RAG, the primary entry points (`README.md`) describe a much simpler, earlier version of the system.

This "Documentation Drift" is the single largest risk factor. It guarantees that new operators will misconfigure the environment, miss critical features, and struggle with onboarding.

**Key Strengths:**
*   **AgentX:** robust Service-Oriented Architecture (SOA), complete "Track 1-6" feature set, production-ready Qdrant integration.
*   **DataAPI:** Functional RBAC, dual-mode data architecture (background + proxy), stable CI/CD.

**Key Weaknesses:**
*   **AgentX README:** Dangerously outdated (claims v1.3.1, omits core services).
*   **DataAPI Architecture:** "Live Data" described as monolithic background service but implemented as hybrid proxy/background.
*   **Security:** API keys exposed in `.env` files within the repository.
*   **Missing Artifacts:** Referenced UI files (`dataapi.html`) do not exist.

---

## 2. Verified Architecture (As-Is)

### 2.1 AgentX: Service-Oriented Architecture
Contrary to the simple MVC implied by the README, AgentX operates on a sophisticated SOA pattern:

*   **Routes (`/routes/*.js`):** Thin validation layers (mostly).
*   **Services (`/src/services/*.js`):** The true core of the application.
    *   `selfHealingEngine.js`: Automated remediation (restart, failover).
    *   `modelRouter.js`: Smart task-based model selection.
    *   `ragStore.js`: Abstracted vector store (Memory/Qdrant).
    *   `benchmarkService.js`: LLM-as-a-judge quality scoring.
*   **Data Flow:** Request → Route → Service → Model/LLM → Response.

### 2.2 DataAPI: Hybrid Data Architecture
The "Live Data" system is not a single pattern as documented, but two distinct implementations:

1.  **Background Ingestion (`scripts/liveData.js`):**
    *   **Behavior:** Autonomous loops fetching and storing data.
    *   **Services:** ISS, Earthquakes, Weather (Archival).
2.  **On-Demand Proxy (`controllers/externalApiController.js`):**
    *   **Behavior:** Passthrough requests to external APIs (OpenWeather, Tides).
    *   **Services:** Tides, Marine, Satellite TLE.
    *   **Note:** These do *not* store data, contradicting the "Data Acquisition" claim for these specific domains.

---

## 3. Critical Discrepancies & Risks

### 3.1 Documentation Drift (Severity: DANGEROUS)

| Component | Documented Claim | Actual Implementation | Risk |
| :--- | :--- | :--- | :--- |
| **AgentX Version** | `v1.3.1` (README) | `1.4.1` (package.json) | Confusion during debugging/deployment. |
| **AgentX Features** | "In-memory vector store" | Production Qdrant support (`src/services/vectorStore/QdrantVectorStore.js`) | Users miss production-readiness features. |
| **DataAPI UI** | `dataapi.html` exists | **File Missing** (404 Not Found) | Broken user journey. |
| **DataAPI Tides** | "Live Data Service" (Stored) | API Proxy (Passthrough) | Misunderstanding of data retention policies. |
| **n8n Integration** | "DataAPI Extension" | Split ownership (AgentX=Triggers, DataAPI=Logs) | Integration failures. |

### 3.2 Security Vulnerabilities (Severity: CRITICAL)

*   **Exposed Secrets:** API keys (`DATAAPI_API_KEY`) are visible in `.env` files committed to the repository or visible in the workspace.
*   **Recommendation:** Immediate rotation of keys and enforcement of `.env.local` (git-ignored) for all secrets.

### 3.3 Architectural Inconsistency (Severity: MEDIUM)

*   **`src/utils` Split:** AgentX contains both `src/utils.js` (file) and `src/utils/` (directory). This is sloppy and confusing.
*   **Route Logic:** Some AgentX routes (`routes/api.js`) still contain business logic (e.g., direct RAG store instantiation) that violates the SOA pattern.

---

## 4. Actionable Recommendations

### Phase 1: Immediate Remediation (Next 24 Hours)

1.  **Security Sweep:** Rotate all API keys and remove `.env` files from version control.
2.  **Fix AgentX README:**
    *   Bump version to `1.4.1`.
    *   Add "Service Architecture" section listing `selfHealingEngine`, `modelRouter`, etc.
    *   Update "Quick Start" to include `VECTOR_STORE_TYPE` and `AGENTX_API_KEY`.
3.  **Fix DataAPI README:**
    *   Remove reference to `dataapi.html`.
    *   Clarify "Live Data" vs "Proxy Services".

### Phase 2: Structural Cleanup (Next Sprint)

4.  **Consolidate Utils:** Move `src/utils.js` content into `src/utils/index.js` or specific modules.
5.  **Unify n8n Documentation:** Create a single "Integration Guide" in `docs/` that explains the split responsibility (AgentX for triggers, DataAPI for logging).
6.  **Implement DataAPI Health Check:** Add `/health` endpoint to DataAPI to match AgentX's monitoring standard.

### Phase 3: Process (Ongoing)

7.  **"Docs as Code":** Enforce a rule that PRs touching `package.json` version must also update `README.md` and `CHANGELOG.md`.

---

## 5. Conclusion

The SBQC Stack is code-complete and production-capable, but its documentation is stuck in the past. The gap between "what it does" and "what it says it does" is now the primary source of technical debt. Closing this gap requires a dedicated documentation sprint, not just ad-hoc fixes.

**Approval Status:**
*   **Codebase:** APPROVED (with minor architectural notes)
*   **Documentation:** REJECTED (Requires immediate overhaul)

