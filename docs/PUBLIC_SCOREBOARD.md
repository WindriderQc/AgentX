# Public scoreboard publication

AgentX stays on the LAN. To show Benchmark results on a public site, an instance
pushes a filtered copy of the scoreboard outward; the public side never calls
back into the home network.

```
Benchmark (loopback API)
   │  summary, generalist leaderboard, efficiency map, host names
   ▼
benchmark-public-publish.js ──► local outbox (public tree)
   │  allow-list, machine names, address guard
   ▼  --send: rsync over SSH, outbound only
public server folder ──► public site reads the JSON files
```

The helper is `integrations/operations/benchmark-public-publish.js`. It reads no
database and runs no model, so it is not heavy work.

## What leaves

| File | Content |
|---|---|
| `summary.json` | Publication date, model/host/test counts, top model |
| `leaderboard.json` | Rankable generalist rows: rank, model, machine, score, coverage, tests, tested categories, confidence margin, evidence status, category averages, last result date; category weights |
| `efficiency.json` | Ranked efficiency entries: model, machine, average quality, tokens/s, latency, test count, efficiency score, Pareto flag, category scores; frontier; totals |
| `model-cards.json` | One card per model with its leaderboard and efficiency results per machine |
| `snapshots.json` | Index of dated releases, newest first |
| `snapshots/<YYYY-MM-DD>.json` | Summary, leaderboard and efficiency as published that day |

Every field is copied by name; a field missing from this list does not leave.
Prompts, responses, reasoning, judge data, prompt names, execution targets,
fingerprints and host status stay private. Unrankable leaderboard rows and
unranked efficiency entries are not published. Markup characters are removed
from text.

## Machine names

Benchmark's `/api/benchmark/host-names` gives the registry name of each host URL
(Core's inference host registry, see Operations → Inference hosts).

- A registered URL publishes its registry name, for example `UGFrank CPU`.
- An unregistered port on a registered machine publishes `<machine> (other instance)`.
- An agent harness (`harness:<kind>:…`) publishes `<kind> agent`; a cloud target its provider.
- Anything else publishes `unlisted host`. A registry name that looks like an address is not used.

Before anything is written, every key and string of every file is scanned. Any
URL, IPv4 or IPv6 address, 4–5 digit port, `localhost`, server path or registered
host address refuses the whole publication (`PUBLIC_PAYLOAD_UNSAFE`). A row whose
model name would trip the scan is dropped first and counted in the report.

## Snapshots

The outbox is the only history; nothing is read back from the public side. When
the published content (rows, weights, efficiency entries) is unchanged, the files
keep their date and no snapshot is added. A change adds or replaces the snapshot
of that day, named in `--time-zone` (default: the machine's zone). The newest
`--keep-snapshots` (default 100) are kept.

## Running

Preview: writes the public tree locally and sends nothing.

```bash
node integrations/operations/benchmark-public-publish.js --outbox /tmp/scoreboard-preview
```

Publish: the same, then rsync over SSH.

```bash
node integrations/operations/benchmark-public-publish.js --outbox <outbox> --send
```

| Setting | Flag | Variable |
|---|---|---|
| Benchmark origin | `--benchmark-url` | `BENCHMARK_SERVICE_URL` (default `http://127.0.0.1:3181`) |
| Public target `user@host:/absolute/folder` | `--target` | `AGENTX_PUBLIC_SCOREBOARD_TARGET` |
| Dedicated SSH key | `--ssh-key` | `AGENTX_PUBLIC_SCOREBOARD_SSH_KEY` |
| Known-hosts file | `--known-hosts` | `AGENTX_PUBLIC_SCOREBOARD_KNOWN_HOSTS` |
| Models kept private (globs, `*` wildcard) | `--exclude-model` (repeatable) | `AGENTX_PUBLIC_SCOREBOARD_EXCLUDE` (comma-separated) |

The report is one JSON line: status (`changed`/`unchanged`), snapshot, written
and removed files, counts, dropped rows and, with `--send`, files sent and
deleted. A failure prints `ok: false` with a code and exits 1; rsync's own error
text is not printed because it can name the server.

## Delivery

rsync sends only the scoreboard files, with strict host-key checking and batch
mode. On the server it can delete nothing except an expired dated snapshot in
`snapshots/`; other files in the target folder are left alone. Unchanged content
is still pushed, so a missed delivery catches up and rsync transfers nothing new.

On the server, give the key one folder and nothing else:

```
command="rrsync -wo /srv/public-scoreboard",restrict ssh-ed25519 AAAA… agentx-public-scoreboard
```

The public site mounts that folder read-only.

## Schedule

`integrations/operations/benchmark-public/` holds an example systemd service and
daily timer. Copy them to the instance user's units. The external environment
file (`~/.config/agentx/public-scoreboard.env`) sets `AGENTX_PRODUCT_ROOT`,
`AGENTX_PUBLIC_SCOREBOARD_OUTBOX` and the settings above. The target, key and
exclusions are instance choices, kept in the private instance repository or
outside Git.
