# Consultative review lenses

The existing `core/scripts/coding-advisory-review.js` command accepts
`--lenses code,ux,visual,performance,security`. Omit it to retain the code-only
default. Select only relevant lenses; this is one bounded consultative call,
not five agents or another execution queue. Unknown, empty and repeated names
refuse before a receipt or inference is created.

Each lens focuses the review on a different question:

- `code`: correctness, regressions and test coverage.
- `ux`: flows, loading/empty/error states, keyboard access and recovery.
- `visual`: consistency and layout, while acknowledging that source is not
  rendered evidence.
- `performance`: repeated work and resource lifecycle; hypotheses remain
  separate from measured improvements.
- `security`: trust boundaries, data exposure and consequential effects.

The existing packet validation, packet fingerprint, native inference admission,
usage, self-review disclosure and uncertain-result behavior remain unchanged.
The private receipt adds `reviewScope`: selected lenses, `supplied_packet_only`
basis, and explicit false facts for browser execution, test execution,
performance measurement and approval power. These describe what this command
did, even if the supplied packet contains measurements from another operator.

The model is asked to list findings and missing evidence separately for each
lens. Its free-text notes are untrusted advice, not a structured PASS verdict.
There is no automatic risk classifier, model selection, Pipeline transition,
PR review, merge or deployment. A source review must not replace browser QA,
device acceptance, measured frame timings or independent executable tests.

## Offline pilot

Run the existing `codingAdvisoryReview.test.js` unit suite with the no-database
guard. Synthetic packets and mocked adapters cover the existing code-only
contract, all five lenses, invalid selections, dry-run without model calls,
admission/unknown outcomes and duplicate-call refusal. This validates the
command contract, not reviewer quality or UI behavior.

For a live pilot, first prepare a verified packet for the exact existing task
and candidate, retaining the original receipt and source authority. Select
`code,ux,visual,performance` for a rendered interface change. Attach the actual
browser and frame-time observations to the reviewed evidence through the
existing workflow. Queue and admit any model call normally. Evaluate whether
the advice identifies real omissions without inventing measurements. Keep the
receipt outside Git; do not treat missing evidence as a confirmed code defect.

See [operations](OPERATIONS.md) for the consultative command and its native
admission, and [coding autonomy](CODING_AUTONOMY.md) for delivery authority.
