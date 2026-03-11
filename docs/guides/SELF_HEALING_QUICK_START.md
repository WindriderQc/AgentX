# Self-Healing Quick Start

This guide is the operational shortcut for AgentX self-healing. Use it when you need to inspect rules, evaluate a rule manually, or understand what the remediation engine can do.

## What It Covers

- Rule-driven remediation in `src/services/selfHealingEngine.js`
- Dashboard and API entry points
- Relationship to model failover, alerts, and health monitoring

## Operator Checklist

1. Open the Self-Healing dashboard at `http://localhost:3080/self-healing.html`.
2. Review current rules and recent execution history.
3. Use manual evaluation before forcing a remediation.
4. Verify downstream effects in alerts, routing, and system health.

## Key API Endpoints

- `GET /api/self-healing/status`
- `GET /api/self-healing/rules`
- `GET /api/self-healing/history`
- `POST /api/self-healing/evaluate`
- `POST /api/self-healing/execute`

## Canonical References

- [Self-Healing Architecture](../architecture/SELF_HEALING_ARCHITECTURE.md)
- [Critical Gotchas](../operations/CRITICAL_GOTCHAS.md)
- [Model Routing](../architecture/MODEL_ROUTING.md)
- [ROADMAP.md](../../ROADMAP.md)