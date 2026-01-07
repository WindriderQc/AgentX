# Bugs Index

This folder is the canonical home for bug intake + durable prevention rules, without polluting repo root docs.

## How to file a bug
- Create a new markdown file under the relevant subfolder:
  - `agentx/` for AgentX UI/backend bugs
  - `dataapi/` for DataAPI bugs
  - `incidents/` for production incidents/outages
- Use filename convention:
  - `YYYY-MM-DD__<product>__<area>__<short-slug>.md`
- Start from [BUG_TEMPLATE.md](BUG_TEMPLATE.md). If you only have logs, paste them under **Evidence** and commit.

## Prevention rules
Every fixed bug should add at least one durable rule under **Fix Summary** in the bug file:
- "Rule: <what to always do / never do>"

## Open bugs
- [2026-01-07__agentx__ui-layout__top-nav-overlaps-page-content.md](agentx/2026-01-07__agentx__ui-layout__top-nav-overlaps-page-content.md)
- [2026-01-07__agentx__prompts__default-chat-404.md](agentx/2026-01-07__agentx__prompts__default-chat-404.md)
