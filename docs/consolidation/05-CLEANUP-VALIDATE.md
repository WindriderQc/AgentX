# Cleanup And Validation

**Run date:** 2026-03-21

## Cleanup Actions

### Permanent docs updated

- `README.md`
- `docs/INDEX.md`
- `docs/architecture/backend-overview.md`
- `docs/architecture/README.md`
- `docs/operations/README.md`
- `docs/testing/README.md`
- `docs/services/model-management/README.md`
- `docs/user-manual/README.md`
- `tests/e2e/README.md`

### New consolidation docs

- `docs/consolidation/00-OVERVIEW.md`
- `docs/consolidation/01-INVENTORY.md`
- `docs/consolidation/02-MAPPING.md`
- `docs/consolidation/03-PERMANENT-DOCS.md`
- `docs/consolidation/04-FRONTEND-UI.md`
- `docs/consolidation/05-CLEANUP-VALIDATE.md`

### New archive structure

- `docs/archive/README.md`
- `docs/archive/2026-03-21/...`

## Archived Files

- `openclawPlan.md`
- `docs/operations/BUG_FIX_HANDOFF.md`
- `docs/operations/START_BUG_SQUAD.md`
- `docs/architecture/SBQC-Stack-Final/00-AUDIT-SUMMARY.md`
- `docs/architecture/SBQC-Stack-Final/AGENT-PROMPT-FOR-VALIDATION.md`
- `docs/architecture/SBQC-Stack-Final/SETUP-SUMMARY-2025-12-31.md`
- `docs/architecture/SBQC-Stack-Final/VALIDATION-REPORT-2025-12-31-1622.md`
- `tests/e2e/TEST_SUMMARY.md`
- `tests/e2e/EXPORT_IMPORT_TEST_SUMMARY.md`
- `tests/e2e/IMPLEMENTATION_REPORT.md`

## Validation Checks

### Broken-link pass

Before cleanup, missing internal links were found for:

- non-existent `docs/Archives/README.md`
- non-existent `docs/features/README.md`
- non-existent `docs/reports/README.md`
- non-existent `docs/reviews/README.md`
- removed benchmark redesign doc
- broken DataAPI doc links from the user manual

Those hub-level issues were removed or redirected during this pass.

### Code alignment checks used

- `src/app.js` for mounted API families and middleware order
- `public/js/components/nav.js` for the canonical navigation model
- `public/*.html` for real UI pages
- repo counts for route, service, model, and page totals

## Follow-Up Recommendations

- Keep future plans and generated reports out of the main doc hub by default.
- Update the user manual whenever `public/js/components/nav.js` changes materially.
- Treat `docs/consolidation/` as the audit trail for this cleanup, then archive it later if a newer consolidation pass replaces it.

