# Memory

- SpecialX supports the `docs_drift_check` task type for read-only documentation drift comparisons against current doc findings and the latest repo snapshot.
- SpecialX now supports `patch_proposal`, `patch_apply`, and `proposal_expiry_sweep` task types for docs-only patch approval flows.
- Patch proposals are stored in `models/PatchProposal.js`, surfaced through `routes/specialx-proposals.js`, and can be approved/rejected from the SpecialX console.
- `src/services/patchProposalExpiryService.js` schedules a nightly `proposal_expiry_sweep` enqueue so pending proposals age out without blocking the runner.
