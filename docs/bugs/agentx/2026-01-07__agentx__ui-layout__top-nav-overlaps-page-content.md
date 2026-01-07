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
- Root cause:
- Fix:
- Tests added/updated:
- Rule added/updated:
- Verified by:
