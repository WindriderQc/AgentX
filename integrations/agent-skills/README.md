# Agent skill refresher

`sync.mjs` keeps the Claude Code and Codex copies of the `agentx` operator
skill equal to the copy an AgentX Core serves at
`GET /api/operator-skill/download`. It needs Node 22 or newer and nothing else.

```bash
node integrations/agent-skills/sync.mjs --core https://core.example --runtime all
```

| Option | Meaning |
| --- | --- |
| `--runtime claude\|codex\|all` | Which copy to refresh. `all` (default) skips a runtime whose home is absent; naming one that is absent fails. |
| `--core <url>` | Core origin. Default: `AGENTX_CORE_URL`, else `http://127.0.0.1:3180`. |
| `--check` | Report only. Exit 3 when a copy is stale. |
| `--force` | Replace even a copy that already matches. |
| `--json` | One JSON report instead of text lines. |

Copies live in `$CLAUDE_CONFIG_DIR/skills/agentx` (default `~/.claude`) and
`$CODEX_HOME/skills/agentx` (default `~/.codex`), on Linux and Windows alike.

## What a run does

1. Downloads the zip and reads it (stored or deflated entries, checksums
   verified, no path outside `agentx/`).
2. Requires `agentx/SKILL.md` declaring `name: agentx` and a
   `Product revision` in `agentx/references/served.md`.
3. Compares each installed copy with the served one: same revision and the
   same files with the same bytes (`served.md` only through its revision, since
   its generation time always changes). An instance sheet edited under an
   unchanged revision therefore still counts as a change.
4. Only when a copy differs, writes the new copy to
   `<runtime home>/.agentx-skill-sync/new`, checks it reads back equal, moves
   the old copy aside, renames the new one into place and removes the old one.
   A rename failure puts the old copy back; a later run also restores a copy
   left aside by an interrupted run.

Any failure (Core unreachable, HTTP error, damaged zip, missing file or
revision) exits 1 and leaves every installed copy as it was. Usage errors exit
2. A copy edited in place is overwritten on the next run: edit the reviewed
source in `skills/agentx/` instead.

A deployment schedules it once a day per machine (a systemd user timer, a
Windows scheduled task) and records where in its own instance notes.

## Tests

```bash
node --test integrations/agent-skills/test/sync.test.mjs
```

The tests build archives with Core's own writer
(`core/src/services/operatorSkill.js`), so a format change on either side fails
here. They also run in `npm run test:integrations`.
