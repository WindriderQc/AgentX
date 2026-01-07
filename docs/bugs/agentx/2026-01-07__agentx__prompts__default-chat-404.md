# default_chat prompt endpoint returns 404

## Title
`GET /api/prompts/default_chat?workspace=...` returns 404

## Product
- agentx

## Severity
- high

## Environment
- Stage: dev
- OS: Linux
- Deploy mode: local

## What Happened
Chat UI attempts to load the active/default chat prompt via `/api/prompts/default_chat?workspace=<workspaceSlug>` and receives HTTP 404.

## What You Expected
Backend should return the default chat prompt for the active workspace (or a clear success response if none exists), so the UI can initialize cleanly.

## Evidence (logs/screenshots)

```
workspace.js:20 [Workspace] Initializing...
workspace.js:59 [Workspace] Loaded 2 workspaces
workspace.js:34 [Workspace] Current workspace: testing-workspace
chat.js:1107  GET http://192.168.2.33:3080/api/prompts/default_chat?workspace=testing-workspace 404 (Not Found)
```

## Repro Steps
- Load chat page with a selected workspace.
- Observe network request to `/api/prompts/default_chat?workspace=...` returns 404.

## Frequency
- always

## Recent Changes
- Multi-tenancy/workspace integration + prompt management UI work.

## Suspected Root Cause
- Prompt routes are workspace-filtering, but legacy prompt configs may not have `workspaceId` set; when a workspace is present, queries can return empty and emit a 404.

## Workaround
- None needed for basic UI label fallback, but it creates noisy errors and can hide real prompt-loading issues.

## Fix Summary (filled after fix)
- Root cause:
- Fix:
- Tests added/updated:
- Rule added/updated:
- Verified by:
