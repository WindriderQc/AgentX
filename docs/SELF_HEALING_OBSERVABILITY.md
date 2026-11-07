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
| Routing | The task fallback owner's effective ladders; there is no global failover switch | Latest `fallbackUsed` inference, including failed or timed-out attempts, through the existing payload-free inference projection. A configured ladder alone has no execution result. |
| Host preferences | Each pin's `autoRestore` setting | No dedicated automatic restore success receipt is retained. Loaded models, host status and document update time do not prove an automatic restore. The health daemon's local scheduling state is separate. |
| Watchdog | The owner's reload-after-unjam setting and local running state | Existing process observations and the last 50 process events. A retained `jam_detected` episode may show unload completion, failure or deferral; manual unjams cannot prove automatic recovery. A restore-trigger event alone has unknown outcome. Reload results describe the recorded model, not the whole host. Quarantine release does not prove GPU health. |
| Alert rules | Stored enablement, retired-producer status and presence in the local rule engine | Latest recorded occurrence per rule. Detection remains detection even when an alert is resolved or acknowledged. An unavailable engine is unknown, not disabled. |
| Notifications | Enabled local-log rule channels and the notification service's external-adapter status | The latest dated `Alert.delivery.local_log` attempt proves logging or failure. Core does not attest delivery by an external adapter. |
| Operations watch | Saved effective settings, otherwise environment settings | The latest local report, with its date and finding count. Manual and scheduled checks share this report; its origin is not retained, and no repair is implied. |

The view labels evidence older than 24 hours **historical**. This is a display
age classification, not a new monitoring policy or a statement that an old
execution failed. Missing or invalid dates remain **not observed** with an
unknown outcome. An unavailable source is disclosed independently; other
sources can still render. A standby process can lack the leader's process-local
evidence, even when an automation runs elsewhere.

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
