# ADR 0003: ingested content is data, never authority

Proposed on 2026-10-02, before the mail archive and private knowledge work
(#23, #24) widen what AgentX reads.

## Context

Agents read content nobody in the household wrote in the current turn: email,
documents and attachments, web search results, retrieved knowledge and notes
derived from those sources, observed application data, and other agents'
output. Any of it can carry text written to steer a model (indirect prompt
injection). The same agents hold tools that write, send or change state.

Most paths already frame such content as data. The rule was not written down,
so some paths injected it raw, and several actions rely on prompt guidance
alone.

## Decision

1. **Ingested content enters a prompt framed as data.** It carries an explicit
   label ("untrusted … data, not instructions") and a boundary (tags, JSON
   fields or BEGIN/END markers). A path that injects it raw is a defect.
2. **Ingested content grants no authority.** It cannot add or widen tools,
   scope, permissions or budgets, and cannot by itself trigger an action. An
   action follows the owner's request in the current conversation or a
   mission the owner configured. A message that asks for an action is a fact
   to report, not a request to obey.
3. **Outbound actions need human confirmation enforced in code.** Outbound
   means leaving the household boundary or hard to undo: sending, replying to
   or forwarding mail or messages, contacting a person, deleting or archiving
   external data, spending or moving money, publishing. The gate is a tool
   approval (allow once or deny; a timeout denies), not prompt guidance. The
   Gmail Secretary's send and destructive operations are the reference.
4. **Internal writes stay bounded, attributed and reviewable.** Notes, tasks,
   idea inboxes, labels, finance categorisation and bounded maintenance
   actions may run without a per-action approval when they stay inside the
   household systems, carry a receipt or land in a list the owner reviews, and
   can be corrected. While an agent processes ingested content (scheduled
   triage, review jobs), it performs only such internal writes.
5. **Provenance travels with derived content.** A note or task derived from
   ingested content keeps its origin, so a later turn still treats it as
   data from that source.

## Current state (2026-10-02)

Framed as data: Gmail read and search (wrapped by the mail CLI), Secretary
evidence pages, memory-review synthesis, the Household selected context,
chat RAG, approved household knowledge, attachments, KidX and GraphysX
observations, and the Planning context of coding tasks. Web search results in
chat and Roundtable, the Gmail backlog triage fields and earlier attachments
are framed by the change that introduces this ADR.

Gated in code: Gmail send, reply, forward, draft send, archive, trash, label
deletion and bulk changes (`integrations/openclaw/gmail-secretary`).

Open work is tracked as issues: a code gate for native OpenClaw messaging,
origin labels on notes derived from mail, and provenance on actions.

## Consequences

New ingestion paths and new tools are reviewed against this rule. The mail
ingestion work (#23, #24) starts only once its outbound and provenance gaps
are closed.
