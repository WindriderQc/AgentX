# Native memory review collectors

These stdlib Python collectors submit bounded, sanitized observations to Core's
existing `/api/memory-review` service. Core owns candidate validation, review,
policy, application and receipts. Runtime-local targets are proposals for their
owning runtime; this collector never edits native memory databases or selected
note stores.

An observation exceeding the text bound is rejected as oversized. The original
source remains untouched; a shortened prefix is never submitted as evidence.

From this directory, `python -m memory_review --help` lists the existing collect,
run, report, digest and watermarks commands. Start with an explicit source and
`collect --dry-run`. Nothing installs a scheduler. The default Core target is
loopback port 3180; set `--agentx-url` for the intended instance. Synthesis needs an
explicit accepted model and the enabled Core Hermes bridge; shadow mode is the
default and this CLI has no apply/approve command.

Windows consumers may use the private HTTPS LAN entry without a human code.
Review calls and synthesis send no parental credential. Remove obsolete code-file
settings from supervisor wrappers; they no longer authenticate these requests.
Redirects remain rejected, and certificate verification remains enabled. Trust the
instance CA through normal Python settings (for example `SSL_CERT_FILE`). Native
consumer grants and memory-review validation/application rules remain separate.

Claude/Codex default project filters select `codes/AgentX` only. Supply explicit
`--claude-project` / `--codex-cwd` filters to review other projects or former
repositories. Git evidence reads a selected local accepted ref (`main` by default),
not an unmerged task branch; pass `--git-repo` explicitly when launching here.
OpenClaw/Hermes homes, agent selection, state/watermarks and reports stay outside
Git. Preserve existing watermarks deliberately; do not read or reset
real runtime state as part of running tests.

The native OpenClaw reader takes every conversation of the selected agents,
whatever its channel (Household, Telegram direct or group, main session); only
scheduled, agent-to-agent and program-driven sessions (OpenClaw classification
`custom` or `explicit`: qualification fixtures, round tables, tool-opened
sessions) are left out. Who spoke is decided per
message from OpenClaw's own owner flag. A Household turn contributes only what
was said after Core's `Current user request:` label. A transcript OpenClaw
rewrote is read again from its start. A run that reaches the session or
observation bound stops there and the next run continues. A session longer than
the history window is read from its latest messages, and the run says so when
turns before the window were never seen. Core accepts 30 candidates per run;
the run prints how many weaker ones were not submitted. Each synthesis keeps
its requests, replies and the model's reasoning under `synthesis/` in the state
directory (owner-only files, the 40 most recent), so a run that proposes
nothing can be read afterwards.

`--openclaw-member-agent` names an agent that serves the household's family
pages. Its turns are submitted as `household_member_statement`: evidence about
someone of the household, never about the owner. The synthesis keeps them apart
from owner statements, and Core sends every candidate resting on one to human
review, whatever its type or confidence.

Selected-note writes use Core `MemoryNote` through the native memory adapter; the
CLI has no separate native-note writer.

The 167 synthetic tests cover filtering of owner versus harness/tool content,
secret sanitation, bounded/resumable collection, API retries, idempotent watermarks,
candidate validation and accepted Git evidence. No personal transcript or model
is used. Native runtime formats, schedules and live acceptance are verified per
instance, not by these tests.
