# PatchProposal Feature — Design Doc

**Status:** Design phase — not implemented
**Depends on:** SpecialX task expansion (docs_drift_check), OpenClaw webhook notifier
**Author:** System Architect
**Date:** 2026-03-10

---

## Problem

`docs_drift_check` identifies stale documentation findings but does nothing about them.
The next step is to generate fix patches and apply them — but applying AI-generated changes to
the repo without human review is unsafe. We need a human-in-the-loop approval step.

---

## Core Constraint: No Task Pause

The AutomationRunner is synchronous and single-occupancy (`this.busy`). A task that blocks
waiting for human input would hold the runner hostage for minutes or hours, preventing all
other task processing. The current lease + heartbeat model is not designed for long-lived
suspensions.

**Therefore: approval happens between two separate, bounded tasks — not inside one.**

---

## Design: Two-Task Pattern

```
Task 1: patch_proposal
  → reads docs_drift_check findings
  → generates markdown diffs for each finding
  → creates PatchProposal documents (status: pending)
  → notifies approval channels
  → marks task completed (fast, deterministic)

[Human reviews in SpecialX console or Telegram]

Task 2: patch_apply (enqueued on approval)
  → reads PatchProposal by ID
  → validates proposal not expired
  → applies the diff to the target file
  → marks PatchProposal status: applied
  → marks task completed
```

No paused state. No lease held during human review. Each task is bounded and finite.

---

## PatchProposal Model

```javascript
// models/PatchProposal.js
{
  sourceTaskId: ObjectId,       // The patch_proposal task that created this
  applyTaskId: ObjectId,        // Set when patch_apply is enqueued
  findingId: ObjectId,          // The Finding this proposal addresses
  targetFile: String,           // Relative path, e.g. "docs/services/foo.md"
  originalContent: String,      // Snapshot at generation time
  proposedContent: String,      // What it should become
  diffSummary: String,          // 1-2 sentence human-readable description
  blastRadius: String,          // 'docs_only' | 'code' (code requires explicit opt-in)
  status: String,               // 'pending' | 'approved' | 'rejected' | 'applied' | 'expired'
  expiresAt: Date,              // Default: +72h from creation
  approvedBy: String,           // 'console' | 'telegram' | 'api'
  approvedAt: Date,
  rejectedAt: Date,
  appliedAt: Date,
  createdAt: Date
}
```

**Scope constraint enforced at task level:**
- `patch_proposal` tasks with `input.blastRadius: 'docs_only'` (default) only generate
  proposals for files under `docs/` and `*.md` files.
- `input.blastRadius: 'code'` requires explicit `codeActions: true` on the SpecialX profile.
  Not implemented in v1.

---

## Approval Channels

### Primary: SpecialX Console
- New "Proposals" tab on `/specialx.html`
- Lists pending proposals with diff preview
- Approve / Reject buttons per proposal
- Hits `POST /api/specialx/proposals/:id/approve` or `/reject`

### Secondary: OpenClaw / Telegram
- OpenClaw receives the completion webhook from `patch_proposal` task
- Formats a Telegram message with diffSummary + inline keyboard [Approve] [Reject]
- Inline button callback hits `POST /api/specialx/proposals/:id/approve?source=telegram`
- **OpenClaw owns the Telegram keyboard.** AgentX only owns the API endpoint.

---

## TTL / Expiry

- Default TTL: 72 hours
- A nightly scheduled task (`proposal_expiry_sweep`, can reuse existing cron slot) sets
  `status: expired` on all PatchProposals where `expiresAt < now && status === 'pending'`
- No auto-deletion. Expired proposals are kept for audit.
- No auto-rejection notification to Telegram (too noisy for expired items).

---

## API Surface (AgentX side)

```
GET  /api/specialx/proposals              # list (filter by status)
GET  /api/specialx/proposals/:id          # single proposal with full diff
POST /api/specialx/proposals/:id/approve  # sets status: approved, enqueues patch_apply
POST /api/specialx/proposals/:id/reject   # sets status: rejected
```

`POST /approve` enqueues a new `patch_apply` AutomationTask with `input.proposalId`.
It returns immediately — does not wait for apply to complete.

---

## New Task Types Required

| Type | Handler | Depends on |
|------|---------|-----------|
| `patch_proposal` | specialxTaskHandlers.js | docs_drift_check findings exist |
| `patch_apply` | specialxTaskHandlers.js | PatchProposal model |
| `proposal_expiry_sweep` | specialxTaskHandlers.js | PatchProposal model |

Add all three to `AutomationTask.type` enum and `SpecialX.taskTypes` enum.

---

## Model Enum Changes

```
AutomationTask.type: add patch_proposal, patch_apply, proposal_expiry_sweep
SpecialX.taskTypes:  add patch_proposal, patch_apply, proposal_expiry_sweep
```

---

## File Checklist (new files)

- `models/PatchProposal.js`
- `routes/specialx-proposals.js` (keep separate from main specialx.js to stay under line limits)
- Console UI tab on `public/specialx.html`
- Expand `public/js/specialx.js` or extract `public/js/specialx-proposals.js`

---

## Implementation Order

1. `models/PatchProposal.js` — standalone, no dependencies
2. `routes/specialx-proposals.js` — CRUD endpoints
3. `patch_proposal` handler in specialxTaskHandlers
4. Console "Proposals" tab UI
5. `patch_apply` handler
6. OpenClaw Telegram integration (external, separate system)
7. `proposal_expiry_sweep` task

---

## What This Is NOT

- Not a code refactoring tool (v1 is docs-only)
- Not autonomous — every patch requires explicit human approval
- Not a git commit tool — it writes files directly; committing is a future concern
- Not a multi-file patch — one PatchProposal per file, per finding
