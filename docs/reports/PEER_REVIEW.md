# AgentX Codebase Peer Review

## Executive Summary

AgentX is a local AI assistant interface designed to interact with Ollama. It features a Node.js backend with Express and a vanilla JavaScript frontend. The project is transitioning from a simple prototype (V1/V2) to a more robust system with RAG capabilities (V3) and Analytics (V4).

However, the codebase currently suffers from **critical runtime errors** and significant technical debt. The most pressing issue is a "split-brain" architecture where `server.js` contains broken inline code that duplicates and conflicts with the modular logic in `routes/`.

## 1. Critical Issues & Bugs

- **Runtime Crashes in `server.js`:** The file references `sessions` and `profile` variables in inline route handlers (e.g., `getSession`, `/api/chat`) without ever declaring them. This will cause `ReferenceError` crashes if these endpoints are hit.
- **Split-Brain Logic:** The application mounts modular routes (e.g., `app.use('/api', apiRoutes)`) but also defines conflicting inline routes for the same paths (e.g., `app.post('/api/chat', ...)`). This creates ambiguity and maintenance nightmares.
- **Broken Database Abstraction:** While `config/db.js` supports SQLite, the core logic in `routes/api.js` bypasses this abstraction and hardcodes Mongoose models. Setting `DB_TYPE=sqlite` will result in a runtime failure as the routes attempt to use Mongoose methods on uninitialized connections.

## 2. Architecture

### Pros
- **Modular Design Intent:** The structure with `routes/`, `models/`, and `services/` is correct and follows standard Express patterns.
- **V3/V4 Specifications:** The architectural vision for RAG and Analytics is well-documented.

### Cons
- **Leaky Abstractions:** The database layer is not truly abstracted. The codebase is effectively tied to MongoDB despite configuration options suggesting otherwise.
- **State Management Confusion:** Session state is attempted in-memory in `server.js` (broken) and persisted in MongoDB in `routes/api.js`.

## 3. Backend

### Strengths
- **RAG Implementation:** The vector search logic in `routes/rag.js` is structured reasonably well.
- **Ollama Proxy:** The core ability to proxy requests to a local LLM is functional.

### Gaps and Required Corrections
- **Remove Duplicate Routes:** The inline routes in `server.js` must be removed. The file should strictly be an entry point that mounts routers.
- **Unify Database Access:** Refactor `routes/api.js` to use a repository pattern or commit fully to MongoDB.
- **Fix Error Handling:** `server.js` defines `buildErrorResponse` but it is not consistently used.
- **Authentication:** User identity is hardcoded to `default`, blocking multi-user usage.

## 4. Frontend

### Strengths
- **Rich Controls:** The UI provides good control over model parameters (temperature, top_k, etc.).
- **No Build Step:** Easy to deploy and modify.

### Weaknesses
- **Monolithic Code:** `public/app.js` is a large, hard-to-maintain file mixing DOM, API, and State logic.
- **Lack of Validation:** Input fields lack client-side validation, allowing invalid data to reach the backend.
- **Accessibility:** Minimal accessibility features.

## 5. Interactions & Features

- **Chat & History:** Works via the modular API, but broken in the inline legacy code.
- **RAG:** Ingestion and search endpoints are defined and follow the V3 contract.
- **Feedback:** Implemented but stored per-message without aggregation.

## 6. Documentation

- **Comprehensive Specs:** The architecture documentation is a highlight (`specs/`).
- **Inconsistent Implementation:** The code often drifts from the implied simplicity of the docs (e.g., the SQLite support).

## Recommendations

1.  **Immediate Fix:** Delete all inline route handlers from `server.js` (`/api/chat`, `/api/ollama/*`, `/api/profile`, etc.) and rely solely on the imported `routes/api.js`. This resolves the `ReferenceError` and the split-brain issue.
2.  **Stabilize Database:** Acknowledge Mongoose dependency and remove/fix the misleading SQLite configuration, or implement a proper Repository pattern.
3.  **Refactor Frontend:** Break `app.js` into smaller ES modules.
4.  **Implement Auth:** Replace the hardcoded 'default' user with a simple authentication mechanism.
