# Native memory review collectors

These stdlib Python collectors submit bounded, sanitized observations to Core's
existing `/api/memory-review` service. Core owns candidate validation, review,
policy, application and receipts. Runtime-local targets are proposals for their
owning runtime; this collector never edits native memory databases or selected
note stores.

From this directory, `python -m memory_review --help` lists the existing collect,
run, report, digest and watermarks commands. Start with an explicit source and
`collect --dry-run`. Nothing installs a scheduler. The default Core target is
loopback port 3180; set `--agentx-url` for the intended instance. Synthesis needs an
explicit accepted model and the enabled Core Hermes bridge; shadow mode is the
default and this CLI has no apply/approve command.

For a Windows consumer using the HTTPS household entry, set
`AGENTX_ACCESS_CODE_FILE` in its existing supervisor wrapper to an ACL-protected
external file containing the same parental code as Core. Both review API calls and
synthesis read the file for each request, so rotating it does not reset collection
state. Missing configuration keeps same-host loopback access unchanged; a selected
empty/unreadable file fails before sending observations. Redirects are rejected.
Trust the instance CA using the normal Python trust settings (for example
`SSL_CERT_FILE`); certificate verification remains enabled.

Claude/Codex default project filters select `codes/AgentX` only. Supply explicit
`--claude-project` / `--codex-cwd` filters to review other projects or former
repositories. Git evidence reads a selected local accepted ref (`main` by default),
not an unmerged task branch; pass `--git-repo` explicitly when launching here.
OpenClaw/Hermes homes, agent selection, state/watermarks and reports stay outside
Git. Preserve existing watermarks deliberately; do not read or reset
real runtime state as part of running tests.

Selected-note writes use Core `MemoryNote` through the native memory adapter; the
CLI has no separate native-note writer.

The 149 synthetic tests cover filtering of owner versus harness/tool content,
secret sanitation, bounded/resumable collection, API retries, idempotent watermarks,
candidate validation and accepted Git evidence. No personal transcript or model
is used. Native runtime formats, schedules and live acceptance are verified per
instance, not by these tests.
