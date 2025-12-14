# DataAPI Consolidation Prompt

## Context
We are refactoring the architecture to align with the "AgentX as Front Door" strategy. AgentX (this repo) is now handling the User Interface, Voice Interaction (STT/TTS), and Agent Routing.

**DataAPI** should transition to being a pure **Tool & Data Service** backend. It should no longer host user-facing control panels or voice processing logic that duplicates AgentX's functionality.

## Objective
Your task is to strip DataAPI of its "agent UI" and "voice" features, securing it as a backend service that AgentX calls to perform tools (e.g., file scanning, live data, NAS operations).

## Instructions

### 1. Remove Legacy UI & Voice
- **Delete `/ai-control`:** Remove the `GET /ai-control` route and its associated view (`views/ai-control.ejs`). This interface is now superseded by AgentX.
- **Remove Voice Endpoints:** If DataAPI has any endpoints for STT/TTS or voice handling (e.g., `POST /api/voice/*`), remove them. Voice is now handled entirely in AgentX (browser-based STT/TTS).
- **Cleanup Assets:** Remove any frontend assets in `public/` that were specific to the AI control panel or voice UI.

### 2. Secure n8n Integration
- **Fix Key Leaks:** Ensure that `process.env.N8N_API_KEY` is **never** injected into any remaining frontend views or exposed to the client.
- **Server-Side Dispatch:** If DataAPI still needs to trigger n8n workflows (as a tool), ensure it's done via a secured server-side endpoint (e.g., `POST /api/tools/n8n/trigger`) that AgentX can call with authentication. Do not allow direct browser-to-n8n calls if they require the secret key.

### 3. Consolidate Tool Endpoints
- **Verify Tool Access:** Ensure that core data functions (storage scanning, file export, live data feeds) are exposed as clean JSON APIs.
- **Route Cleanup:** Deprecate or remove `routes/web.routes.js` if it only served the now-removed UI. Keep `routes/api.routes.js` focused on data tools.

### 4. Verification
- **Security Check:** Grep the codebase for `N8N_API_KEY` and ensure it only appears in server-side logic (controllers/services), never in views or public scripts.
- **Functionality:** Confirm that the server starts and `npm test` (or equivalent) passes, ensuring that removing the UI didn't break the backend API.

## Outcome
DataAPI will be a headless service providing tools to AgentX. AgentX will own the user experience.
