# AgentX V4 n8n Prompt-Improvement Loops

This guide defines four n8n workflows that implement the V4 improvement cycles using Agent A/B's contracts. They only call public AgentX APIs and avoid backend changes. Default schedules and thresholds are suggestions—tune them per environment.

## Environment variables
Set these in n8n (global credentials or per-workflow):

- `AGENTX_BASE_URL` – e.g., `http://localhost:3080`.
- `AGENTX_API_KEY` – API key if required (Bearer token header).
- `POSITIVE_RATE_THRESHOLD` – default `0.7` (70%).
- `MIN_FEEDBACK_COUNT` – default `50` (minimum conversations before acting).
- `HEALTH_LOOKBACK_DAYS` – default `7`.
- `DATASET_EXPORT_LIMIT` – default `500` per batch.

Use the HTTP Request node with base URL `${AGENTX_BASE_URL}` and header `Authorization: Bearer {{$env.AGENTX_API_KEY}}` when required.

## WORKFLOW_MONITORING – Prompt Health Check
**Name:** `Prompt Health Check`

**Trigger:** Cron (daily, e.g., 02:00 UTC).

**Goal:** Flag prompt versions with low positive feedback rates given enough volume.

**Nodes (in order):**
1. **Cron** – set desired daily time.
2. **HTTP Request** – `GET /api/analytics/feedback?sinceDays={{$env.HEALTH_LOOKBACK_DAYS}}`. Expect per-promptVersion metrics (positive, negative, total counts).
3. **Function** – compute `positiveRate = positive / Math.max(total, 1)`, compare against `POSITIVE_RATE_THRESHOLD` and `MIN_FEEDBACK_COUNT`, and mark `needsReview` boolean.
4. **IF** – split `needsReview == true` vs. others.
5. **Markdown / Set** – format a summary per candidate: promptConfig name, version, counts, rate, and `needsReview: true` flag.
6. **Notification** – Email or Slack node posts the summary to the monitoring channel. Include instruction to open evaluation workflow for each candidate.
7. **Error Handling** – HTTP node retries on 5xx/timeouts; failed branches log to a file or emit a separate alert.

**Notes:**
- The Function node should skip items where `total < MIN_FEEDBACK_COUNT` to avoid reacting to noise.
- Keep the summary compact so multiple candidates fit in one message.

## WORKFLOW_EVALUATION – Deep Dive on Bad Conversations
**Name:** `Evaluate Negative Conversations`

**Trigger:** Manual or scheduled (e.g., weekly). Accepts input `promptConfigId` or uses IDs from the monitoring workflow.

**Goal:** Sample worst conversations, ask an LLM for diagnosis and prompt-instruction improvements, then save a proposal via API.

**Nodes (in order):**
1. **Manual Trigger** – optional input `promptConfigId` and `limit`.
2. **HTTP Request** – `GET /api/dataset/conversations?feedback=negative&promptConfigId={{$json.promptConfigId}}&limit={{$json.limit || 20}}`.
3. **Split In Batches** – iterate each conversation.
4. **LLM Node** (OpenAI/compatible) – Prompt template:
   - System: "You are evaluating AgentX responses for quality control."
   - User: include conversation transcript, the model answer, and user feedback.
   - Ask for: (a) concise reason for failure, (b) a better answer, (c) system-prompt instructions to prevent the issue.
5. **Merge** – collect LLM outputs.
6. **Function** – aggregate suggestions into a single proposal payload with fields like `promptConfigId`, `analysisWindow`, `examplesReviewed`, `proposedSystemPrompt`, and `rationale`.
7. **HTTP Request** – `POST /api/prompt-configs` (or dedicated proposals endpoint if Agent A/B exposes one). Set status to `"proposed"` and attach the aggregated rationale/metadata.
8. **Notification** – send a summary link to approvers.

**Notes:**
- Keep per-conversation payloads small; truncate long transcripts before sending to the LLM.
- Use retry plus dead-letter handling for API/LLM failures.

## WORKFLOW_ROLLOUT – Controlled Prompt Activation
**Name:** `Prompt Rollout Controller`

**Trigger:** Manual (with human approval) or scheduled if automated rules are allowed.

**Goal:** Review proposed prompts and activate vetted versions.

**Nodes (in order):**
1. **Manual Trigger / Cron** – start the review cycle.
2. **HTTP Request** – `GET /api/prompt-configs?status=proposed` to list candidates.
3. **IF** – branch per candidate; optional filters (e.g., require `rationale` present or a minimum number of evaluated examples).
4. **Approval Step** –
   - Option A: Send Slack/Email with buttons/links; wait for a **Webhook** response to proceed.
   - Option B: Automatic check via **Function** node applying custom rules (e.g., aligns with safety tags, reviewed by LLM guardrails).
5. **HTTP Request** – `PATCH /api/prompt-configs/:id/activate` for approved items; optionally include `deprecatedPrevious: true`.
6. **Notification** – confirm activation and record previous active version.
7. **Audit Log** – write activation events to a storage node (database/file) for traceability.

**Notes:**
- Keep human-in-the-loop as default; only use automation when safety and regression checks exist.
- Add a cooldown timer so multiple activations don’t happen simultaneously.

## WORKFLOW_DATASET_EXPORT – Export for Fine-Tuning
**Name:** `Dataset Export`

**Trigger:** Scheduled (e.g., weekly) or manual.

**Goal:** Pull curated examples for future fine-tuning or offline evaluation.

**Nodes (in order):**
1. **Manual Trigger / Cron** – choose `promptConfigId`, `limit`, and `feedback` filters.
2. **HTTP Request** – call dataset endpoints, e.g.,
   - Positive set: `GET /api/dataset/conversations?feedback=positive&promptConfigId={{id}}&limit={{$env.DATASET_EXPORT_LIMIT}}`
   - Hard negatives: `GET /api/dataset/conversations?feedback=negative&promptConfigId={{id}}&limit={{$env.DATASET_EXPORT_LIMIT}}`
3. **Function** – map records to JSONL lines with fields like `user`, `assistant`, `feedback`, `promptVersion`, and optional `metadata`.
4. **Merge** – combine positive and negative batches.
5. **Write Binary File** – save JSONL/CSV to storage (e.g., `/data/exports/agentx-${date}.jsonl`).
6. **Optional Upload** – push file to S3/Blob/FTP using existing n8n nodes.
7. **Notification** – send export stats and path to downstream fine-tuning pipeline owners.

**Notes:**
- Respect pagination: loop until fewer than `limit` items are returned.
- Store hashes or timestamps in filenames to avoid accidental overwrites.

## Operational guidelines
- Reuse a shared HTTP credential for all AgentX calls.
- Enable retries with exponential backoff on HTTP nodes; keep errors flowing to a dead-letter queue or log.
- For sampling-based steps, seed randomness or use deterministic selection for reproducibility.
- Keep proposal payloads minimal and within fields that Agent A/B defined; avoid introducing new JSON shapes without contract updates.
