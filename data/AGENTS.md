# AgentX Data capability

Follow the canonical root AGENTS.md. Data owns storage/network inventory,
live feeds, exports, database inspection, janitor domain rules and integrations.
Core hosts its optional operator UI and consumes Data over HTTP. Native collectors
run only on explicitly configured hosts and roots, outside Docker.

Preserve read-only inventory and the existing preview/approval boundary for file
mutations. Never run a real scan or janitor action as a test. Use `npm test` for
the unit and disposable-Mongo integration suites; no production URI is consumed.
Instance settings, paths, collector identity and personal data stay outside Git.
