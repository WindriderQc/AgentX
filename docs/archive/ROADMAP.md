# Central Roadmap (AgentX + DataAPI)

**Canonical roadmap and todos for the stack.**

**Last Updated:** 2026-01-03

---

## Scope
This roadmap covers:
- **AgentX** (UI + orchestration + AI services)
- **DataAPI** (tool server + data acquisition)
- **AgentC** workflows (n8n automation)

If you only care about DataAPI-specific work, see `DataAPI/docs/planning/ROADMAP.md`.

---

## Now (Next 1–2 sessions)

### 1) Documentation normalization (this work)
- [ ] Ensure `docs/INDEX.md` exists and is canonical in both repos
- [ ] Ensure a single canonical roadmap + progression log exists
- [ ] Ensure `CLAUDE.md` points at the canonical docs entrypoints

### 2) Track 6 wiring gaps (Backup & Disaster Recovery)
Source: `docs/planning/MULTI_AGENT_ENHANCEMENT_PLAN.md`
- [ ] Fix Qdrant backup listing mismatch (route expects `qdrant_*.tar.gz` vs script output `*.snapshot`)
- [ ] Decide ownership of backup scripts (AgentX `/scripts/` vs DataAPI `/scripts/`) and document it
- [ ] Resolve missing workflow backup automation artifacts:
  - [ ] Confirm whether `/AgentC/N4.5.json` should exist (plan references it)
  - [ ] Confirm whether `./scripts/commit-workflows.sh` exists / should be added

### 3) Alerts end-to-end connection
Source: `docs/planning/MULTI_AGENT_ENHANCEMENT_PLAN.md`
- [ ] Verify N1.1 + N5.1 workflows actively call `/api/alerts` (currently noted as a wiring gap)
- [ ] Add/verify a minimal “alert creation” smoke test path (workflow → AgentX → UI)

---

## Current State (High confidence, as of 2026-01-03)

### Landed / substantially implemented
(See `docs/planning/MULTI_AGENT_ENHANCEMENT_PLAN.md` for full detail.)
- Track 1 Alerts system (backend + UI + tests present)
- Track 2 Metrics/analytics collection/routes
- Track 3 Custom model management
- Track 4 Self-healing engine + remediation actions + tests
- Track 5 CI/CD + Jest/Playwright + load testing

### Partial / needs wiring
- Track 6 Backup & Disaster Recovery (APIs + scripts exist, but mismatches + missing automation artifacts)

---

## Later

### Phase 2: Security hardening
Source: `GLOBAL_PLAN.md`
- [ ] Rate limiting strategy + middleware
- [ ] Helmet configuration (CSP/HSTS) for production
- [ ] API key scopes/rotation strategy

---

## Notes / Canonical References
- AgentX development plan snapshot: `GLOBAL_PLAN.md`
- Stack documentation hub: `docs/SBQC-Stack-Final/`
