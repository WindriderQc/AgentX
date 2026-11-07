# Automation evidence

The Nerve Center's **Diagnostics → Automation evidence** reads existing
configuration and observations through `GET /api/nerve-center/self-healing`.
It does not run checks, synchronize rules, send notifications, reload models,
change pins or acquire runtime authority. It refreshes every 30 seconds while
visible. The response uses `Cache-Control: no-store`.

The summary covers routing fallbacks, task fallback ladders, pin restoration,
the inference watchdog, alert rules, local notifications and operations watch.
It is not a catalogue of every scheduled job; `/automations` keeps that role.
Manual model, runtime and placement remedies retain their operator links.

Configuration and execution are separate:

| Source owner | Configuration | Retained evidence and limits |
| --- | --- | --- |
| Routing | The task fallback owner's validator reads the active host mapping without refreshing it or changing its execution cache; there is no global failover switch | Latest `fallbackUsed` inference, including failed, cancelled or timed-out attempts, through the existing payload-free inference projection. A configured ladder alone has no execution result. |
| Host preferences | Each pin's `autoRestore` setting | No dedicated automatic restore success receipt is retained. Loaded models, host status and document update time do not prove an automatic restore. The health daemon's local scheduling state is separate. |
| Watchdog | The owner's reload-after-unjam setting and local running state | Existing process observations and the last 50 process events. An automatic result requires matching host, execution identity and autonomous origin from the producer. Manual probes and manual unjams carry manual origin, including their delayed completions. Legacy events without that provenance stay unknown. A restore-trigger event alone has unknown outcome. Reload results describe the recorded model, not the whole host. Quarantine release does not prove GPU health. |
| Alert rules | Stored enablement, retired-producer status and presence in the local rule engine | Latest recorded occurrence per rule. Detection remains detection even when an alert is resolved or acknowledged. An unavailable engine is unknown, not disabled. |
| Notifications | Enabled effective local-log rule channels, including the owner's empty-channel fallback, and the notification service's external-adapter status | The latest dated `Alert.delivery.local_log` attempt proves logging or failure only when its outcome is explicit. Core does not attest delivery by an external adapter. |
| Operations watch | Saved effective settings, otherwise environment settings | The latest local report, with its date and finding count. Findings observed in this report do not prove alert publication completed. Manual and scheduled checks share this report; its origin is not retained, and no repair is implied. |

The view labels evidence older than 24 hours **historical**. This is a display
age classification, not a new monitoring policy or a statement that an old
execution failed. Missing or invalid dates remain **not observed** with an
unknown outcome. An unavailable source is disclosed independently; other
sources can still render. A standby process can lack the leader's process-local
evidence, even when an automation runs elsewhere.

A result timestamp must be valid, no earlier than its trigger and no later
than the completed read. Watchdog identities are process observation references,
not execution grants. Reading the summary never creates these identities or
events; only the existing execution paths produce them. Each read copies the
watchdog history before waiting for other sources, so later events cannot
silently change that snapshot.

Configuration reads are limited to 200 hosts and 200 rules. Alert history is
grouped by rule before its 200-group presentation limit; truncation is disclosed.
Database reads have a five-second execution limit. Credentials, raw inference
payloads, coordination tokens and arbitrary alert context are excluded.

CPU tests exercise synthetic rule events and delivery receipts, configuration
disablement, historical and absent evidence, manual/automatic separation,
unchanged persisted records across repeated reads, and browser rendering.
They do not qualify a deployment, an installed external adapter, a live failover,
model recovery, GPU behavior or physical-device acceptance. Runtime recovery
remains the [existing operator procedure](OPERATIONS.md#profiler-restoration-and-unknown-recovery).
