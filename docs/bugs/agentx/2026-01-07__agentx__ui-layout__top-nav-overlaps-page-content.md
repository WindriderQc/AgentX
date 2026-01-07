# Top nav overlaps page content

## Title
Top nav overlaps page content on many pages

## Product
- agentx

## Severity
- medium

## Environment
- Stage: dev
- OS: Linux
- Deploy mode: local

## What Happened
Many pages render with content starting underneath the top navigation, causing the nav to overlap the page content.

## What You Expected
Page content should start below the top nav consistently on all pages.

## Evidence (logs/screenshots)
(Reported verbally; often discovered via visual overlap.)

## Repro Steps
- Navigate to newly created pages (various).
- Observe content begins at the top, underneath the nav.

## Frequency
- intermittent (but common on new pages)

## Recent Changes
- Ongoing rapid page creation by multiple agents.

## Suspected Root Cause
- Likely a fixed/sticky header without a shared layout wrapper applying consistent top padding/margin.

## Workaround
- Per-page padding-top (undesirable; causes drift).

## Fix Summary (filled after fix)
- Root cause: `.top-nav` is `position: fixed` (does not occupy layout space), and many pages were relying on ad-hoc `padding-top`/`margin-top` hacks (or none at all), so new pages frequently rendered content under the nav.
- Fix: `injectNav()` now reserves layout space by setting `#nav-container` height to the actual nav height (and updates it on load/resize). This makes the offset consistent across pages without per-page CSS.
- Tests added/updated: None.
- Rule added/updated: Rule: Never add per-page top padding to compensate for the top nav. Always include `<div id="nav-container"></div>` + `/js/components/nav.js` and rely on the shared injector to reserve the correct header space.
- Verified by: Manual inspection of affected pages after removing page-level padding hacks.
