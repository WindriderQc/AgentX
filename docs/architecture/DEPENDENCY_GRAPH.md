# Inter-Service Dependency Graph

This document defines the directed acyclic dependency graph for the AgentX Platform
10-service decomposition. Every allowed inter-service call, event subscription, and
cross-database read is enumerated below. **No dependency may exist that is not listed here.**

---

## Full Dependency Graph (ASCII)

```
                          +-----------+
                          | SpecialX  |
                          +-----+-----+
                           /    |    \
                          v     v     v
                   +------+ +------+ +-----+
                   | Chat | | Ops  | |Model|
                   +--+---+ +------+ |Mgmt |
                  /   |   \          +--+---+
                 v    v    v            ^  ^
           +-----+ +-----+ +--------+  |  |
           |Model| | RAG | |Prompt &|  |  |
           |Mgmt | +-----+ |Config  |  |  |
           +-----+         +--------+  |  |
                                       |  |
              +-------------+----------+  |
              |             |             |
        +-----+-----+ +----+------+ +----+------+
        | Benchmark  | |Self-Heal  | | Workspace |
        +------------+ +-----+-----+ +-----+-----+
                             |  \           |
                             v   v          v
                       +-----++ +--------+ +--------+
                       |Alert | |Prompt &| |Alerting|
                       |ing   | |Config  | +--------+
                       +------+ +--------+


  Reads only (no writes):
        +-----------+
        | Analytics |---reads---> Conversation DB
        +-----------+---reads---> Alert DB
```

### Simplified Directed Graph

```
  SpecialX ──────> Chat ──────> Model Mgmt (leaf)
     |               |───────> RAG (leaf)
     |               └───────> Prompt & Config (leaf)
     |──────> Model Mgmt
     └──────> Ops

  Benchmark ──────> Model Mgmt (leaf)

  Self-Healing ──> Model Mgmt (leaf)
       |────────> Alerting (leaf)
       └────────> Prompt & Config (leaf)

  Workspace ─────> Alerting (leaf)

  Analytics ─────> [DB read-only: Conversation, Alert]
```

**Leaf services** (zero outbound dependencies):
`RAG`, `Model Management`, `Alerting`, `Prompt & Config`

---

## Dependency Edge Table

| # | Source Service | Target Service | What Is Consumed | Interface Type |
|---|---------------|----------------|-----------------|----------------|
| 1 | Chat | Model Management | `routeRequest()` -- route a prompt to the best available model host | Function call |
| 2 | Chat | RAG | `search()` -- retrieve relevant context chunks for a conversation | Function call |
| 3 | Chat | Prompt & Config | `getActivePrompt()` -- resolve the active system prompt for a persona | Function call |
| 4 | Benchmark | Model Management | `HOSTS` -- enumerate registered inference hosts | Function call (read) |
| 5 | Benchmark | Model Management | `routeRequest()` -- send benchmark prompts to specific models | Function call |
| 6 | Benchmark | Model Management | `hardwareProfileService` -- read GPU/CPU specs for benchmark context | Function call |
| 7 | Self-Healing | Model Management | `failover()` -- trigger model failover when health degrades | Function call |
| 8 | Self-Healing | Alerting | `createAlert()` -- raise an alert when remediation runs | Function call |
| 9 | Self-Healing | Prompt & Config | `rollback()` -- revert a prompt/config change that caused degradation | Function call |
| 10 | SpecialX | Chat | `handleChatRequest()` -- execute a task step through the chat pipeline | Function call |
| 11 | SpecialX | Model Management | `routeRequest()` -- direct model calls bypassing chat (tool-use, structured output) | Function call |
| 12 | SpecialX | Ops | `repoWatcher` -- subscribe to repository change events for CI triggers | Function call / Event |
| 13 | Analytics | Conversation DB | Read conversation history, token usage, latency stats | DB read-only |
| 14 | Analytics | Alert DB | Read alert history, resolution times, severity distribution | DB read-only |
| 15 | Workspace | Alerting | `email()` -- send workspace invitation and notification emails | Function call |

---

## Dependency Rules

### 1. No Cycles

The graph above is a strict DAG. Before adding any new edge, verify that it does not
introduce a cycle. If service A depends on service B, then service B (and all of B's
transitive dependencies) must never depend on A.

### 2. Write Cross-Access Prohibited

No service may write to another service's database tables or state stores. All mutations
must go through the owning service's public interface (function call or event).

**Violation example (forbidden):**
```
Analytics service INSERT INTO conversations ...   -- PROHIBITED
```

**Correct pattern:**
```
Chat service owns conversations table
Analytics reads conversations via shared DB read-only access
```

### 3. Read-Only Cross-Access Permitted

Services may hold read-only access to another service's database when:

- The dependency is explicitly listed in the edge table above with interface type `DB read-only`.
- The reading service never writes, updates, or deletes rows.
- Schema changes in the owning service must be communicated to all registered readers.

Currently approved read-only cross-access:

| Reader | Database / Collection | Owner |
|--------|----------------------|-------|
| Analytics | Conversation records | Chat |
| Analytics | Alert records | Alerting |

### 4. Event-Based Decoupling Preferred

When a service needs to react to state changes in another service but does not need a
synchronous response, use the `systemEvents` EventEmitter bus instead of adding a direct
function call dependency. See [EVENT_CATALOG.md](EVENT_CATALOG.md) for the full list of
system events.

### 5. Adding a New Dependency

To add a new inter-service dependency:

1. Verify the new edge does not create a cycle.
2. Add the edge to the table above with source, target, consumed interface, and type.
3. Update the ASCII graph.
4. If the dependency is event-based, add the event to `EVENT_CATALOG.md`.
5. Commit both doc updates in the same changeset as the code change.

---

## Service Summary

| Service | Outbound Deps | Inbound Deps | Classification |
|---------|--------------|--------------|----------------|
| Chat | 3 (Model Mgmt, RAG, Prompt & Config) | 1 (SpecialX) | Core pipeline |
| Model Management | 0 | 4 (Chat, Benchmark, Self-Healing, SpecialX) | Leaf |
| RAG | 0 | 1 (Chat) | Leaf |
| Prompt & Config | 0 | 2 (Chat, Self-Healing) | Leaf |
| Alerting | 0 | 2 (Self-Healing, Workspace) | Leaf |
| Benchmark | 1 (Model Mgmt) | 0 | Edge |
| Self-Healing | 3 (Model Mgmt, Alerting, Prompt & Config) | 0 | Edge |
| SpecialX | 3 (Chat, Model Mgmt, Ops) | 0 | Edge / Orchestrator |
| Workspace | 1 (Alerting) | 0 | Edge |
| Analytics | 0 function deps; 2 DB reads | 0 | Observer (read-only) |
| Ops | 0 | 1 (SpecialX) | Utility |
