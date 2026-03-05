# Event Catalog

This document is the canonical registry of all events emitted through the AgentX Platform
`systemEvents` EventEmitter bus. Every event, its producer, consumers, payload shape, and
purpose is defined here. **No event may be emitted or consumed in code that is not listed
in this catalog.**

---

## Event Bus Overview

AgentX uses a process-local `EventEmitter` instance (`systemEvents`) for decoupled
inter-service communication. Events are fire-and-forget within the Node.js process.
They are not persisted, not guaranteed to be delivered across restarts, and must not be
used for operations that require transactional guarantees.

**When to use events:**
- Notifying downstream services of state changes (health, completion, failure).
- Triggering side effects that are independent of the producing service's control flow.
- Feeding analytics and audit pipelines without coupling the producer to them.

**When NOT to use events:**
- Synchronous request/response flows (use direct function calls).
- Operations that must succeed atomically with the producer's transaction.
- Cross-process or cross-host communication (use HTTP/queue instead).

---

## Event Registry

| Event Name | Producer | Consumers | Payload | Description |
|---|---|---|---|---|
| `rag:ingestion:complete` | RAG Service | Chat (cache invalidation) | `{ documentId: string, chunks: number, duration: number }` | Fired when a document has been fully chunked, embedded, and indexed. Chat service uses this to invalidate any cached context that may reference stale embeddings. |
| `rag:ingestion:error` | RAG Service | Alerting | `{ error: string, documentId: string }` | Fired when document ingestion fails at any stage (parsing, chunking, embedding, or indexing). Alerting service creates a warning-level alert for operator review. |
| `model:failover` | Model Management | Alerting, Self-Healing, Analytics | `{ fromHost: string, toHost: string, model: string, reason: string }` | Fired when the model router switches traffic from one inference host to another due to health degradation, timeout, or explicit operator action. |
| `model:health:changed` | Model Management | Analytics, Self-Healing | `{ host: string, status: string, latency: number }` | Fired when a monitored inference host transitions between health states (healthy, degraded, unreachable). Includes the latest measured latency in milliseconds. |
| `benchmark:batch:complete` | Benchmark Service | Analytics | `{ batchId: string, results: object[], duration: number }` | Fired when a full benchmark batch finishes successfully. Results array contains per-model scores, latencies, and token throughput metrics. |
| `benchmark:batch:failed` | Benchmark Service | Alerting | `{ batchId: string, error: string }` | Fired when a benchmark batch fails to complete. Alerting service creates an alert so operators can investigate infrastructure or configuration issues. |
| `alert:fired` | Alerting Service | Self-Healing | `{ alertId: string, rule: string, severity: string, data: object }` | Fired when an alert rule triggers. Self-Healing service evaluates the alert against its remediation ruleset and may take automated corrective action. Severity is one of: `critical`, `warning`, `info`. |
| `alert:resolved` | Alerting Service | Analytics | `{ alertId: string }` | Fired when a previously active alert is resolved, either automatically (condition cleared) or manually (operator acknowledgment). Analytics records resolution time. |
| `specialx:task:complete` | SpecialX Service | Analytics | `{ taskId: string, type: string, duration: number, status: string }` | Fired when a SpecialX task run finishes successfully. Analytics ingests the record for task throughput and duration tracking. |
| `specialx:task:failed` | SpecialX Service | Alerting | `{ taskId: string, error: string }` | Fired when a SpecialX task run fails after exhausting retries or hitting a terminal error. Alerting creates a warning or critical alert depending on task priority. |
| `workspace:member:added` | Workspace Service | Audit Log | `{ workspaceId: string, userId: string, role: string }` | Fired when a new member is added to a workspace. The audit log consumer persists the event for compliance and traceability purposes. |
| `remediation:executed` | Self-Healing Service | Analytics, Alerting | `{ ruleId: string, action: string, success: boolean }` | Fired after the self-healing service executes an automated remediation action (failover, rollback, restart). Alerting creates a follow-up alert if `success` is false. |

---

## Event Flow Diagrams

### RAG Ingestion Flow

```
  RAG Service
      |
      |── rag:ingestion:complete ──> Chat Service (invalidate context cache)
      |
      └── rag:ingestion:error ─────> Alerting Service (create warning alert)
```

### Model Health and Failover Flow

```
  Model Management
      |
      |── model:health:changed ────> Analytics (record health timeline)
      |                         ───> Self-Healing (evaluate remediation rules)
      |
      └── model:failover ─────────> Alerting (create failover alert)
                              ────> Self-Healing (update failover state)
                              ────> Analytics (record failover event)
```

### Benchmark Flow

```
  Benchmark Service
      |
      |── benchmark:batch:complete ──> Analytics (ingest scores and metrics)
      |
      └── benchmark:batch:failed ────> Alerting (create alert)
```

### Alert Lifecycle Flow

```
  Alerting Service
      |
      |── alert:fired ────────> Self-Healing (evaluate and remediate)
      |
      └── alert:resolved ─────> Analytics (record resolution time)

  Self-Healing Service
      |
      └── remediation:executed ──> Analytics (record action outcome)
                             ───> Alerting (follow-up alert if failed)
```

### SpecialX Task Flow

```
  SpecialX Service
      |
      |── specialx:task:complete ──> Analytics (task throughput tracking)
      |
      └── specialx:task:failed ────> Alerting (create task failure alert)
```

### Workspace Membership Flow

```
  Workspace Service
      |
      └── workspace:member:added ──> Audit Log (persist for compliance)
```

---

## Consumer Subscription Summary

This table inverts the registry to show what each consuming service listens to.

| Consumer | Events Subscribed |
|---|---|
| Chat | `rag:ingestion:complete` |
| Alerting | `rag:ingestion:error`, `model:failover`, `benchmark:batch:failed`, `specialx:task:failed`, `remediation:executed` |
| Self-Healing | `model:failover`, `model:health:changed`, `alert:fired` |
| Analytics | `model:failover`, `model:health:changed`, `benchmark:batch:complete`, `alert:resolved`, `specialx:task:complete`, `remediation:executed` |
| Audit Log | `workspace:member:added` |

---

## Conventions

### Naming

Event names follow the pattern:

```
<domain>:<entity>:<action>
```

- **domain**: The owning service's bounded context (e.g., `rag`, `model`, `benchmark`, `alert`, `specialx`, `workspace`, `remediation`).
- **entity**: The resource or concept the event describes (e.g., `ingestion`, `health`, `batch`, `task`, `member`).
- **action**: The state transition (e.g., `complete`, `failed`, `changed`, `fired`, `resolved`, `executed`, `added`).

### Payload Rules

1. Payloads must be plain JSON-serializable objects. No class instances, functions, or circular references.
2. Every payload must include at least one identifier field (e.g., `documentId`, `alertId`, `taskId`) to allow consumers to correlate events with source records.
3. Duration fields are in milliseconds.
4. Error fields contain a human-readable string. Stack traces must not be included in event payloads (log them separately).

### Adding a New Event

1. Add the event to the registry table above with all required columns filled.
2. Add the event to the consumer subscription summary.
3. Update or add an event flow diagram if the event introduces a new interaction pattern.
4. Ensure the event name follows the `<domain>:<entity>:<action>` convention.
5. Commit the catalog update in the same changeset as the code that emits/consumes the event.
