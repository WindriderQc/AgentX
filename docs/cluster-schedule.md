# Cluster Schedule

Unified view of what's using the LLM/GPU hosts and when. AgentX aggregates schedules from OpenClaw, AgentX, n8n, and persistent Ollama models into one timeline.

## Architecture

```
Data Sources                          AgentX
─────────────                         ──────
OpenClaw (ClawdX .66)
  └─ ~/.openclaw/cron/jobs.json  ──→  POST /api/cluster/schedule/sync
       (via sync-openclaw-schedule.js)       │
                                             ▼
n8n (Ubundocker .199)                 ClusterScheduleEntry (MongoDB)
  └─ seed script (static)                   │
                                             ├─→ GET /schedule          (list + filter)
AgentX (Docker Host .33)                    ├─→ GET /schedule/timeline  (24h heatmap)
  └─ seed script (static)                  ├─→ GET /schedule/next      (countdown)
                                             └─→ GET /schedule/live     (Ollama /api/ps)
Ollama Hosts                                        │
  └─ live polled via /api/ps                        ▼
                                             cluster.html (dashboard)
```

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `models/ClusterScheduleEntry.js` | 39 | Mongoose schema — source, schedule, host, model, taskType |
| `src/services/clusterScheduleService.js` | 245 | CRUD, cron→timeline resolution, sync upsert |
| `src/services/clusterLiveService.js` | 80 | Real-time Ollama /api/ps polling per host (node-fetch) |
| `routes/cluster-schedule.js` | 103 | 5 API endpoints mounted at `/api/cluster` |
| `scripts/seed-cluster-schedule.js` | ~320 | Baseline data: 12 OpenClaw + 7 n8n + 5 AgentX + 3 GPU |
| `scripts/sync-openclaw-schedule.js` | 150 | Reads OpenClaw jobs.json → POSTs to sync API (zero deps) |
| `public/cluster.html` | 191 | Dashboard: live bar, 24h heatmap, next up |
| `public/js/cluster-schedule.js` | 300 | Frontend logic: fetch, render, countdown |
| `tests/unit/clusterScheduleService.test.js` | 285 | 19 tests covering all service methods |

## API Endpoints

All mounted at `/api/cluster`, use `optionalAuth` middleware.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/schedule` | List entries. Filters: `?host=&taskType=&source=&enabled=` |
| GET | `/schedule/timeline` | 24h time slots. `?date=YYYY-MM-DD&timezone=America/Toronto` |
| GET | `/schedule/live` | Real-time host status + loaded models from Ollama |
| GET | `/schedule/next` | Next N upcoming tasks. `?count=5` (max 50) |
| POST | `/schedule/sync` | Upsert entries by source+sourceId. Body: `{ entries: [...] }` |

Response format: `{ status: 'success', data: {...} }`

## OpenClaw Sync

The sync script reads OpenClaw's `~/.openclaw/cron/jobs.json` directly and POSTs to AgentX. Zero OpenClaw code changes. Zero npm dependencies (uses Node 18+ built-in fetch).

OpenClaw `jobs.json` is the source of truth for OpenClaw-owned recurring jobs only. AgentX remains the canonical merged schedule view for the broader cluster.

### Real jobs.json schema (OpenClaw)

```jsonc
// "every" kind (infra-health-check)
{
  "id": "d15704a8-...",
  "agentId": "main",
  "name": "infra-health-check",
  "enabled": true,
  "schedule": { "kind": "every", "everyMs": 7200000, "anchorMs": 1771558409376 },
  "payload": { "kind": "agentTurn", "model": "local", "thinking": "off" },
  "delivery": { "mode": "none", "channel": "last" },
  "state": {
    "lastRunAtMs": 1772667457001, "lastDurationMs": 681916,
    "lastStatus": "error", "consecutiveErrors": 1, "nextRunAtMs": 1772674657001
  }
}

// "cron" kind (morning-briefing)
{
  "id": "c95e6849-...",
  "agentId": "main",
  "name": "morning-briefing",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 8 * * 1-5", "tz": "America/Toronto" },
  "payload": { "kind": "agentTurn", "thinking": "minimal" },
  "delivery": { "mode": "announce", "channel": "telegram", "to": "8272389726" },
  "state": {
    "lastRunAtMs": 1772629200018, "lastDurationMs": 30072,
    "lastStatus": "ok", "consecutiveErrors": 0, "nextRunAtMs": 1772715600000
  }
}
```

Key mappings in the sync script:
- `job.schedule.kind` → "cron" uses `expr`, "every" uses `everyMs`
- `job.agentId` (NOT `job.agent`)
- `job.state.*` for runtime stats (NOT flat fields)
- `job.delivery` is a sibling of `payload` (NOT `payload.delivery`)
- `job.payload.model` → resolved via MODEL_ALIASES to full model name + host

### Model aliases

| Alias | Model | Host |
|-------|-------|------|
| small | qwen3:8b | tertiary (UGFrank) |
| local | qwen3:14b | primary (UGClawdX) |
| main | qwen3-coder:30b | primary (UGClawdX) |
| big | qwen3.5:27b | primary (UGClawdX) |
| think | deepseek-r1:14b | secondary (UGBrutal) |
| coder | deepcoder:14b-preview-q4_K_M | secondary (UGBrutal) |
| oss | openclaw-oss-20b | secondary (UGBrutal) |
| mistral | Mistral-Small3.1-24B | secondary (UGBrutal) |

### Deploy to ClawdX

```bash
# Copy script (one file, zero deps)
scp scripts/sync-openclaw-schedule.js clawdx:~/sync-openclaw-schedule.js

# Add 15-min cron
ssh clawdx '(crontab -l 2>/dev/null; echo "*/15 * * * * node ~/sync-openclaw-schedule.js >> /tmp/openclaw-sync.log 2>&1") | crontab -'

# Verify
ssh clawdx 'node ~/sync-openclaw-schedule.js'
```

## GPU Hosts

| Host | ID | IP | GPU | Role |
|------|----|----|-----|------|
| UGFrank | tertiary | 192.168.2.99 | RTX 3080 Ti 12GB | 3-8B models, embeddings |
| UGBrutal | secondary | 192.168.2.12 | RTX 5070 Ti 16GB | 14B reasoning/coding |
| UGClawdX | primary | 192.168.2.66 | RTX 3090 24GB | stable default local inference, OpenClaw runtime |

## Repository Layout

| Path | Role | Branch |
|------|------|--------|
| `~/.openclaw/workspace-clawdx-coder/AgentX/` | Dev — OpenClaw's agent works here | any |
| `~/codes/AgentX/` | Prod — what runs on .33 | main only |

## OpenClaw Jobs (13 total)

All jobs from `~/.openclaw/cron/jobs.json`, synced every 15 min to AgentX.

| Job | Agent | Schedule | Model | Host | Delivery |
|-----|-------|----------|-------|------|----------|
| infra-health-check | main | every 2h | small | tertiary | none |
| morning-briefing | main | `0 8 * * 1-5` | main | primary | telegram |
| memory-maintenance | main | `0 22 * * 0,3` | main | primary | none |
| healthcheck:security-audit | main | `0 6 * * 1` | local | primary | none |
| agentx:daily-analytics | main | `0 18 * * *` | main | primary | telegram |
| agentx:weekly-benchmark | clawdx-coder | `0 14 * * 6` | main | primary | telegram |
| agentx:rag-maintenance | clawdx-coder | `0 3 * * 3` | main | primary | none |
| self-improve:weekly-report | main | `0 9 * * 1` | main | primary | telegram |
| self-improve:model-quality-watch | thinker | `0 20 * * *` | main | primary | telegram |
| leantime:daily-status | main | `30 8 * * *` | main | primary | telegram |
| roadmap-driver:work-cycle | roadmap-driver | `0 2 * * 1-5` | main | primary | none |
| roadmap-driver:bisync | roadmap-driver | `0 7 * * 1-5` | local | primary | telegram |
| session-cleanup | main | `0 4 * * 0` | local | primary | none |

All cron expressions are America/Toronto timezone.

## Known Limitations (v1)

- **Timezone boundary**: Timeline uses UTC day boundaries (00:00Z–23:59Z). Late-night local tasks (e.g., 23:00 Toronto = 04:00Z next day) may fall outside the window.
- **n8n data is static**: Seeded once, not live-synced. n8n webhook integration deferred.
- **No conflict detection**: The dashboard shows overlaps visually but doesn't warn about VRAM conflicts.
- **Seed data for OpenClaw is baseline**: Once sync cron is deployed, real data from jobs.json overrides the seed.
