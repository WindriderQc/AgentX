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
- Root cause: `attachWorkspace` middleware too strict for read-only routes. When workspace slug provided in query param (e.g., `?workspace=testing-workspace`) but workspace doesn't exist in database, middleware threw 404 error before route handler could execute its graceful fallback logic for `default_chat`.
- Fix: Created new middleware `optionalWorkspaceContext` in `/src/middleware/workspace.js` that loads workspace if valid slug provided but sets `req.workspace = null` (instead of rejecting with 404) if workspace invalid or missing. Updated GET routes in `/routes/prompts.js` (lines 18 and 71) to use `optionalWorkspaceContext` instead of `attachWorkspace`. POST/PATCH/DELETE routes unchanged (still use strict `attachWorkspace`).
- Tests added/updated: Manual testing confirmed invalid workspace slugs now return 200 with empty array for `default_chat`, chat UI loads without 404 errors.
- Rule added/updated: Rule: For read-only routes that should gracefully handle missing workspace context, use `optionalWorkspaceContext` middleware instead of `attachWorkspace`. Reserve `attachWorkspace` for mutation operations (POST/PATCH/DELETE) that require valid workspace.
- Verified by: Manual testing (invalid workspace slug returns 200, chat UI loads cleanly), syntax checks passed for both modified files (workspace.js, prompts.js), server logs clean (no 404 errors for default_chat requests).
