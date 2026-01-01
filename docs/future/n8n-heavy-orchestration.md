# n8n Heavy Orchestration Rules
## SBQC BrainX Hybrid Mode

This document defines the **strict operational contract** for n8n workflows used in BrainX heavy research mode.

n8n is an **orchestrator**, not an author.

---

## Allowed Responsibilities

n8n MAY:
- Execute parallel retrieval strategies.
- Call multiple RAG endpoints with variant queries.
- Call multiple LLMs for independent analysis.
- Normalize outputs into structured formats.
- Run a judge / comparison LLM pass.
- Emit progress and telemetry.
- Retry failed sub-tasks.

---

## Forbidden Responsibilities

n8n MUST NOT:
- Generate final user-facing prose.
- Modify AgentX conversation state directly.
- Decide UX behavior.
- Store long-term conversational memory.
- Invent interpretations beyond evidence extraction.

---

## Workflow Shape (Mandatory)

Every BrainX heavy workflow MUST follow this structure:

1. **Webhook Trigger**
   - Receives jobId, conversationId, messageId, queryPlan.

2. **Fan-Out Phase**
   - Multiple parallel retrieval strategies.
   - Each branch is independent and stateless.

3. **Normalization Phase**
   - Convert all outputs into EvidencePackets.
   - Remove duplicates.
   - Preserve provenance.

4. **Judge Phase**
   - Identify agreements, conflicts, gaps.
   - Rank evidence by relevance and reliability.
   - Produce structured judgment only.

5. **Callback Phase**
   - POST results back to AgentX.
   - Never respond directly to UI.

---

## Evidence Packet Contract

Each evidence item MUST include:
- source identifier
- retrieval method
- confidence estimate
- raw excerpt or data
- tool/model used

No free-form prose.

---

## Failure Handling

- Partial failure is acceptable.
- Total failure must be reported explicitly.
- Silent failure is forbidden.
- Timeouts must be enforced.

---

## Design Philosophy

n8n is the **swarm controller**.
AgentX is the **mind**.
BrainX is the **judge**.

Break this rule and the system becomes untrustworthy.
