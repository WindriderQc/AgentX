# Model Routing System

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Model Routing

> **Context:** Smart multi-host routing with persistent failover state. Integrates with [Model Registry](MODEL_REGISTRY.md) for category-based routing.

## Overview

**Service:** `/src/services/modelRouter.js`

The Model Router implements intelligent request distribution across multiple Ollama hosts with automatic failover and task-based routing.

---

## Two-Phase Routing

### Phase 1: Query Classification

Small fast model (Qwen 7B) classifies user intent into task types.

### Phase 2: Model Selection

Routes to appropriate host/model based on task type:

| Task Type | Target | Models |
|-----------|--------|--------|
| `quick_chat` | Primary host | Lightweight models |
| `code_generation` | Secondary host | Specialist models |
| `deep_reasoning` | Secondary host | Reasoning models |

---

## Host Configuration

```javascript
HOSTS = {
  primary: process.env.OLLAMA_HOST,              // Required
  secondary: process.env.OLLAMA_HOST_SECONDARY   // Optional: Heavy models
}
```

**Critical:** When `autoRoute=true` is passed to chat API, user's model selection is **OVERRIDDEN** by routing decision.

---

## Persistent Failover State

ModelRouter maintains in-memory failover state for self-healing integration.

### State Tracking

```javascript
ACTIVE_HOST_STATE = {
  current: 'http://192.168.2.99:11434',  // Currently active host
  failedOver: false,                      // Whether failover is active
  failoverTimestamp: '2026-01-03T...',   // When failover occurred
  reason: 'self_healing_failover',        // Reason for failover
  failoverCount: 3                        // Total failovers this session
}
```

### API Methods

| Method | Purpose |
|--------|---------|
| `getActiveHost()` | Returns current host URL |
| `getBackupHost()` | Returns alternate host URL |
| `switchHost(url, reason)` | Performs failover with reason tracking |
| `getFailoverStatus()` | Returns full state object |
| `resetToPrimary(reason)` | Manually reset to primary host |

---

## Integration with Self-Healing

The Model Router integrates with the Self-Healing System (Track 4) for automated remediation:

1. Self-Healing Engine detects host issues
2. Triggers `switchHost()` with reason
3. Failover state persists for monitoring
4. Health checks can trigger `resetToPrimary()` when recovered

**Full documentation:** [Self-Healing Quick Start](../SELF_HEALING_QUICK_START.md)

---

## Related Documentation

- [Model Registry](MODEL_REGISTRY.md) - Model categorization for routing
- [Self-Healing System](../../ROADMAP.md#track-4-self-healing--remediation) - Failover integration
- [Critical Gotchas](../operations/CRITICAL_GOTCHAS.md) - Auto-routing override behavior

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
