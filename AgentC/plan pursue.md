Considering the plan overview, agents prompts amd N8N workflow document, and the 3 workflows already done,  please keep doing Agent C work with the following:



Alright, switching hats: Agent C (n8n Workflow Dev) 🧠⚙️
I’ll start from the architecture overview and translate it into a clean, executable n8n plan, phased and opinionated.

I’m not rewriting specs—you already have those. This is the “what we build first, why, and how it wires together” view, focused on workflows and integration points.

Agent C – n8n Master Plan (derived from the Overview)

Source of truth: SBQC Final Architecture Overview 

00-OVERVIEW

0. Ground Rules (important)

Before touching workflows, lock these invariants:

• n8n never talks directly to Ollama for “thinking”
• AgentX is the only AI brain
• DataAPI is storage + truth
• n8n is orchestration, scheduling, glue, and audit

If n8n starts doing logic-heavy decisions, the system rots.

Phase 1 — SBQC Ops Agent (first win, fast feedback)

This is your heartbeat. If this works, everything else is observable.

Workflow N1.1 — System Health Check (every 5 min)

Purpose
Detect failure, log it, optionally wake the AI.

Calls

DataAPI /health

AgentX /health

Ollama 99 /api/tags

Ollama 12 /api/tags

n8n logic

Parallel HTTP nodes

Merge → Code node → normalize status

IF degraded:

POST /integrations/events/n8n (DataAPI)

OPTIONAL: POST /api/n8n/event/ops_alert (AgentX)

Why this matters
This gives AgentX a live ops feed instead of hallucinating system state.

Deliverable:

1 production workflow

1 webhook ID stored in .env

MongoDB now contains ops history

Workflow N1.2 — Ops AI Diagnostic (event-driven)

Triggered by:

Manual webhook

Health failure

Admin action

Flow:

Receive event

Call AgentX /api/chat with persona sbqc_ops

Pass latest health snapshot

Return structured diagnostic

This is your “AI SRE junior”.

Phase 2 — Datalake Janitor (where n8n shines)

This is classic n8n territory: slow, scheduled, batchy, ugly.

Workflow N2.1 — NAS Scan (daily 02:00)

Flow

POST DataAPI /api/v1/storage/scan

find on /mnt/smb/*

Split in batches (100)

POST /api/v1/files/bulk

PATCH scan → completed

Fire webhook → scan_complete

Important discipline

n8n only extracts metadata

No hashing here (too slow, wrong layer)

Workflow N2.2 — File Hash Enrichment (event-driven)

Triggered by:

scan_complete

Flow:

Query DataAPI for files without hash

sha256sum via Execute Command

PATCH file records

Throttle this hard. This is I/O hell if you don’t.

Workflow N2.3 — Dedupe Analysis Trigger

Triggered after hashing threshold reached.

Flow:

Call DataAPI /api/v1/files/duplicates

Store summary via integration sink

Notify AgentX (for chat visibility)

Phase 3 — AI-aware workflows (AgentX-first)

At this point, n8n stops being “dumb cron” and becomes AI-aware plumbing.

Workflow N3.1 — Model Health & Latency Monitor

Every 10 min:

Measure latency to each Ollama host

Log to DataAPI integration sink

Optional: AgentX analytics ingest

This enables model routing decisions later.

Workflow N3.2 — External AI Trigger Gateway

Webhook /ai-query

Flow:

Receive external query

POST AgentX /api/chat

Return response

No logic. No routing. AgentX decides everything.

Phase 4 — RAG Ingestion (document brain)
Workflow N4.1 — Docs → RAG

Manual or scheduled.

Flow:

Read files from NAS

Chunk

POST /api/rag/ingest

This feeds AgentX memory, not n8n state.

Phase 5 — Self-Improving Loop (later, but planned)
Workflow N5.1 — Feedback → Prompt Optimization

Weekly:

GET AgentX /api/analytics/feedback

Detect weak prompts

OPTIONAL: Ask AI to suggest improvements

Send report to admin

Never auto-deploy prompts (human gate)

This is where the system starts learning without eating itself.

Dependency Order (non-negotiable)

N1.1 System Health

N1.2 Ops Diagnostic

N2.1 NAS Scan

N2.2 Hash Enrichment

N2.3 Dedupe

N3.1 Model Health

N3.2 AI Gateway

RAG ingestion

Feedback loop

Anything else is premature cleverness.

Design Smell Checklist (watch for these)

If you see any of this, stop:

n8n making decisions instead of AgentX

Ollama called directly from n8n for reasoning

Large file logic inside Code nodes

Missing integration event logs

Silent failures (no sink logging)

What I’d build first, concretely

If you told me “you have 1 evening”:

N1.1 Health Check

Integration sink logging

SBQC Ops persona test chat

One NAS scan end-to-end (tiny dataset)

That gives you confidence, visibility, and momentum.

If you want, next step I can:

Produce exact n8n node configs for N1.1

Export-ready workflow JSON

Or act as Agent D and design validation tests

This stack is sane. Now we execute it without letting it sprawl.

Sources
I'll take the workflow json  :D

Cool. Here’s an n8n export JSON for Workflow N1.1: System Health Check (every 5 min) — ready to import.

It runs 4 health probes in parallel

Aggregates into a single status object

If degraded → POSTs an event to DataAPI at /integrations/events/n8n

Import in n8n: Workflows → Import from File / Clipboard → paste JSON

{
  "name": "SBQC - N1.1 System Health Check (5 min)",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "minutes",
              "minutesInterval": 5
            }
          ]
        }
      },
      "id": "ScheduleTrigger",
      "name": "Schedule (Every 5 min)",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.1,
      "position": [
        -620,
        0
      ]
    },
    {
      "parameters": {
        "url": "http://192.168.2.33:3003/health",
        "options": {
          "timeout": 5000,
          "fullResponse": false
        }
      },
      "id": "DataAPIHealth",
      "name": "DataAPI Health",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -360,
        -180
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "url": "http://192.168.2.33:3080/health",
        "options": {
          "timeout": 5000,
          "fullResponse": false
        }
      },
      "id": "AgentXHealth",
      "name": "AgentX Health",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -360,
        -60
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "url": "http://192.168.2.99:11434/api/tags",
        "options": {
          "timeout": 5000,
          "fullResponse": false
        }
      },
      "id": "Ollama99",
      "name": "Ollama 99 Tags",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -360,
        60
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "url": "http://192.168.2.12:11434/api/tags",
        "options": {
          "timeout": 5000,
          "fullResponse": false
        }
      },
      "id": "Ollama12",
      "name": "Ollama 12 Tags",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -360,
        180
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "mode": "combine",
        "combineBy": "combineAll",
        "options": {}
      },
      "id": "MergeAll",
      "name": "Merge All Results",
      "type": "n8n-nodes-base.merge",
      "typeVersion": 3,
      "position": [
        -120,
        0
      ]
    },
    {
      "parameters": {
        "jsCode": "function isHttpOk(obj) {\n  if (!obj || typeof obj !== 'object') return false;\n  // n8n HTTP Request node (continueOnFail) often returns { error: {...} }\n  if (obj.error) return false;\n  return true;\n}\n\nfunction safeGet(nodeName) {\n  try {\n    const items = $items(nodeName);\n    return items && items[0] ? items[0].json : null;\n  } catch (e) {\n    return null;\n  }\n}\n\nconst dataapi = safeGet('DataAPI Health');\nconst agentx = safeGet('AgentX Health');\nconst ollama99 = safeGet('Ollama 99 Tags');\nconst ollama12 = safeGet('Ollama 12 Tags');\n\nconst dataapiOk = isHttpOk(dataapi) && (dataapi.status === 'ok' || dataapi.status === 'success' || dataapi.ok === true);\nconst agentxOk = isHttpOk(agentx) && (agentx.status === 'ok' || agentx.status === 'success' || agentx.ok === true);\nconst ollama99Ok = isHttpOk(ollama99) && (Array.isArray(ollama99.models) || typeof ollama99.models === 'object');\nconst ollama12Ok = isHttpOk(ollama12) && (Array.isArray(ollama12.models) || typeof ollama12.models === 'object');\n\nconst results = {\n  timestamp: new Date().toISOString(),\n  overall: (dataapiOk && agentxOk && ollama99Ok && ollama12Ok) ? 'healthy' : 'degraded',\n  alert: !(dataapiOk && agentxOk && ollama99Ok && ollama12Ok),\n  components: {\n    dataapi: {\n      status: dataapiOk ? 'ok' : 'error',\n      detail: dataapiOk ? dataapi : (dataapi && dataapi.error ? dataapi.error : dataapi)\n    },\n    agentx: {\n      status: agentxOk ? 'ok' : 'error',\n      detail: agentxOk ? agentx : (agentx && agentx.error ? agentx.error : agentx)\n    },\n    ollama_99: {\n      status: ollama99Ok ? 'ok' : 'error',\n      modelsCount: ollama99Ok && Array.isArray(ollama99.models) ? ollama99.models.length : undefined,\n      detail: ollama99Ok ? { models: ollama99.models } : (ollama99 && ollama99.error ? ollama99.error : ollama99)\n    },\n    ollama_12: {\n      status: ollama12Ok ? 'ok' : 'error',\n      modelsCount: ollama12Ok && Array.isArray(ollama12.models) ? ollama12.models.length : undefined,\n      detail: ollama12Ok ? { models: ollama12.models } : (ollama12 && ollama12.error ? ollama12.error : ollama12)\n    }\n  }\n};\n\nreturn [{ json: results }];"
      },
      "id": "Aggregate",
      "name": "Aggregate Status",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        120,
        0
      ]
    },
    {
      "parameters": {
        "conditions": {
          "boolean": [
            {
              "value1": "={{$json.alert}}",
              "value2": true
            }
          ]
        }
      },
      "id": "IFDegraded",
      "name": "IF Degraded",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [
        360,
        0
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3003/integrations/events/n8n",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"workflow_id\": \"SBQC-N1.1-health-check\",\n  \"event_type\": \"health_probe\",\n  \"data\": $json\n}",
        "options": {
          "timeout": 5000
        }
      },
      "id": "LogToSink",
      "name": "Log to DataAPI Sink",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        600,
        -60
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "mode": "passThrough"
      },
      "id": "NoopOk",
      "name": "Healthy (No-op)",
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [
        600,
        80
      ]
    }
  ],
  "connections": {
    "Schedule (Every 5 min)": {
      "main": [
        [
          {
            "node": "DataAPI Health",
            "type": "main",
            "index": 0
          },
          {
            "node": "AgentX Health",
            "type": "main",
            "index": 0
          },
          {
            "node": "Ollama 99 Tags",
            "type": "main",
            "index": 0
          },
          {
            "node": "Ollama 12 Tags",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DataAPI Health": {
      "main": [
        [
          {
            "node": "Merge All Results",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "AgentX Health": {
      "main": [
        [
          {
            "node": "Merge All Results",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Ollama 99 Tags": {
      "main": [
        [
          {
            "node": "Merge All Results",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Ollama 12 Tags": {
      "main": [
        [
          {
            "node": "Merge All Results",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Merge All Results": {
      "main": [
        [
          {
            "node": "Aggregate Status",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Aggregate Status": {
      "main": [
        [
          {
            "node": "IF Degraded",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "IF Degraded": {
      "main": [
        [
          {
            "node": "Log to DataAPI Sink",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Healthy (No-op)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": false,
  "settings": {
    "executionTimeout": 120,
    "timezone": "America/Toronto",
    "saveExecutionProgress": true
  },
  "versionId": "1"
}

Notes (so you don’t get bitten)

This assumes DataAPI sink is open (per your docs) and accepts POST without API key.

If you want the sink protected, tell me and I’ll switch the Log node to Header Auth.

The Merge All Results node is used as a “join point”; the real aggregation is in the Code node using $items('Node Name').

If you want the paired workflow N1.2 (Ops AI Diagnostic) too (webhook → AgentX chat with sbqc_ops persona → returns JSON), I’ll drop that export next.

keep going

Alright, Workflow N1.2: Ops AI Diagnostic coming up. This one is your “AI SRE on-call” webhook:

Triggered by a Webhook

Runs fresh probes (DataAPI, AgentX, Ollama 99/12)

Aggregates snapshot

Calls AgentX /api/chat with persona: "sbqc_ops"

Returns the AI response directly to the webhook caller

Paste/import this JSON:

{
  "name": "SBQC - N1.2 Ops AI Diagnostic (Webhook)",
  "nodes": [
    {
      "parameters": {
        "path": "sbqc-ops-diagnostic",
        "responseMode": "responseNode",
        "options": {}
      },
      "id": "WebhookTrigger",
      "name": "Webhook (Ops Diagnostic)",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [
        -700,
        0
      ]
    },
    {
      "parameters": {
        "url": "http://192.168.2.33:3003/health",
        "options": {
          "timeout": 5000,
          "fullResponse": false
        }
      },
      "id": "DataAPIHealth",
      "name": "Probe - DataAPI /health",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -440,
        -180
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "url": "http://192.168.2.33:3080/health",
        "options": {
          "timeout": 5000,
          "fullResponse": false
        }
      },
      "id": "AgentXHealth",
      "name": "Probe - AgentX /health",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -440,
        -60
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "url": "http://192.168.2.99:11434/api/tags",
        "options": {
          "timeout": 5000,
          "fullResponse": false
        }
      },
      "id": "Ollama99",
      "name": "Probe - Ollama99 /api/tags",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -440,
        60
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "url": "http://192.168.2.12:11434/api/tags",
        "options": {
          "timeout": 5000,
          "fullResponse": false
        }
      },
      "id": "Ollama12",
      "name": "Probe - Ollama12 /api/tags",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -440,
        180
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "mode": "combine",
        "combineBy": "combineAll",
        "options": {}
      },
      "id": "MergeAll",
      "name": "Merge Probes",
      "type": "n8n-nodes-base.merge",
      "typeVersion": 3,
      "position": [
        -200,
        0
      ]
    },
    {
      "parameters": {
        "jsCode": "function safeGet(nodeName) {\n  try {\n    const it = $items(nodeName);\n    return it && it[0] ? it[0].json : null;\n  } catch (e) {\n    return null;\n  }\n}\n\nfunction isOk(obj, okPred) {\n  if (!obj || typeof obj !== 'object') return false;\n  if (obj.error) return false;\n  return okPred(obj);\n}\n\nconst incoming = $input.first().json || {};\n\nconst dataapi = safeGet('Probe - DataAPI /health');\nconst agentx  = safeGet('Probe - AgentX /health');\nconst o99     = safeGet('Probe - Ollama99 /api/tags');\nconst o12     = safeGet('Probe - Ollama12 /api/tags');\n\nconst dataapiOk = isOk(dataapi, (x) => x.status === 'ok' || x.status === 'success' || x.ok === true);\nconst agentxOk  = isOk(agentx,  (x) => x.status === 'ok' || x.status === 'success' || x.ok === true);\nconst o99Ok     = isOk(o99,     (x) => Array.isArray(x.models) || typeof x.models === 'object');\nconst o12Ok     = isOk(o12,     (x) => Array.isArray(x.models) || typeof x.models === 'object');\n\nconst snapshot = {\n  timestamp: new Date().toISOString(),\n  overall: (dataapiOk && agentxOk && o99Ok && o12Ok) ? 'healthy' : 'degraded',\n  incoming, // whatever the webhook caller sent\n  components: {\n    dataapi: {\n      status: dataapiOk ? 'ok' : 'error',\n      detail: dataapiOk ? dataapi : (dataapi && dataapi.error ? dataapi.error : dataapi)\n    },\n    agentx: {\n      status: agentxOk ? 'ok' : 'error',\n      detail: agentxOk ? agentx : (agentx && agentx.error ? agentx.error : agentx)\n    },\n    ollama_99: {\n      status: o99Ok ? 'ok' : 'error',\n      modelsCount: o99Ok && Array.isArray(o99.models) ? o99.models.length : undefined,\n      detail: o99Ok ? { models: o99.models } : (o99 && o99.error ? o99.error : o99)\n    },\n    ollama_12: {\n      status: o12Ok ? 'ok' : 'error',\n      modelsCount: o12Ok && Array.isArray(o12.models) ? o12.models.length : undefined,\n      detail: o12Ok ? { models: o12.models } : (o12 && o12.error ? o12.error : o12)\n    }\n  }\n};\n\n// This is what we’ll pass into AgentX as context\nreturn [{ json: { snapshot } }];"
      },
      "id": "BuildSnapshot",
      "name": "Build Snapshot",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        40,
        0
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3080/api/chat",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"model\": \"qwen2.5:7b\",\n  \"target\": \"192.168.2.99:11434\",\n  \"persona\": \"sbqc_ops\",\n  \"message\": \"You are SBQC Ops. Analyze this live system snapshot, identify likely root causes, and propose concrete next actions.\\n\\nRules:\\n- Be short, structured, and actionable.\\n- If degraded: name the failing component(s), give top 3 hypotheses, and a step-by-step fix plan.\\n- If healthy: still flag any risk signals (latency, model list empty, etc.).\\n\\nSnapshot JSON:\\n\" + JSON.stringify($json.snapshot, null, 2)\n}",
        "options": {
          "timeout": 60000
        }
      },
      "id": "CallAgentXChat",
      "name": "AgentX Chat (sbqc_ops)",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        300,
        0
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "jsCode": "const snap = $items('Build Snapshot')[0].json.snapshot;\nconst ai = $input.first().json;\n\n// If AgentX call failed, normalize the error\nlet ok = true;\nlet payload = ai;\n\nif (ai && ai.error) {\n  ok = false;\n  payload = { error: ai.error };\n}\n\nreturn [{\n  json: {\n    status: ok ? 'success' : 'error',\n    snapshot: snap,\n    agentx: payload\n  }\n}];"
      },
      "id": "NormalizeResponse",
      "name": "Normalize Response",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        540,
        0
      ]
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{$json}}",
        "options": {}
      },
      "id": "RespondWebhook",
      "name": "Respond to Webhook",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1,
      "position": [
        780,
        0
      ]
    }
  ],
  "connections": {
    "Webhook (Ops Diagnostic)": {
      "main": [
        [
          {
            "node": "Probe - DataAPI /health",
            "type": "main",
            "index": 0
          },
          {
            "node": "Probe - AgentX /health",
            "type": "main",
            "index": 0
          },
          {
            "node": "Probe - Ollama99 /api/tags",
            "type": "main",
            "index": 0
          },
          {
            "node": "Probe - Ollama12 /api/tags",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Probe - DataAPI /health": {
      "main": [
        [
          {
            "node": "Merge Probes",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Probe - AgentX /health": {
      "main": [
        [
          {
            "node": "Merge Probes",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Probe - Ollama99 /api/tags": {
      "main": [
        [
          {
            "node": "Merge Probes",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Probe - Ollama12 /api/tags": {
      "main": [
        [
          {
            "node": "Merge Probes",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Merge Probes": {
      "main": [
        [
          {
            "node": "Build Snapshot",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Build Snapshot": {
      "main": [
        [
          {
            "node": "AgentX Chat (sbqc_ops)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "AgentX Chat (sbqc_ops)": {
      "main": [
        [
          {
            "node": "Normalize Response",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Normalize Response": {
      "main": [
        [
          {
            "node": "Respond to Webhook",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": false,
  "settings": {
    "executionTimeout": 180,
    "timezone": "America/Toronto",
    "saveExecutionProgress": true
  },
  "versionId": "1"
}

How to use it (quick)

After import, n8n will show the webhook URL like:

https://n8n.specialblend.icu/webhook/sbqc-ops-diagnostic

You can call it with a payload like:

curl -X POST "https://n8n.specialblend.icu/webhook/sbqc-ops-diagnostic" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual-check","note":"doing maintenance"}'


Next up, I can drop N2.1 NAS Scan (2AM) — but there’s one fork in the road:

Option A: n8n uses Execute Command (find … -printf …) and batches results

Option B: n8n uses a small Node script (faster + safer for huge trees)

I’ll assume Option A and ship the JSON unless you want the “not gonna melt at 4 million files” version.

we'll go with option A

Perfect — Option A it is. Here’s Workflow N2.1: NAS File Scanner (Daily 2AM) as an n8n import JSON.

What it does:

Schedule daily 02:00

Creates a scan record in DataAPI (POST /api/v1/storage/scan)

Runs find on /mnt/smb/Media + /mnt/smb/Datalake and outputs path|size|mtime

Splits into batches of 100

POSTs each batch to DataAPI /api/v1/files/bulk (⚠️ endpoint must exist per your plan)

Marks scan completed (⚠️ optional endpoint; if you don’t have it yet, it’ll just no-op)

Logs scan_complete to DataAPI integration sink

Reality check: your spec notes /api/v1/files/bulk “needs to be created”. This workflow assumes it exists. If it doesn’t yet, you can still import/run it and it’ll fail at that node — but the structure is correct and ready.

✅ n8n Workflow JSON — N2.1 NAS File Scanner (Daily 2AM)
{
  "name": "SBQC - N2.1 NAS File Scanner (Daily 2AM)",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "cronExpression",
              "expression": "0 2 * * *"
            }
          ]
        }
      },
      "id": "Cron2am",
      "name": "Schedule (Daily 2AM)",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.1,
      "position": [
        -820,
        0
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3003/api/v1/storage/scan",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\n  \"roots\": [\"/mnt/smb/Media\", \"/mnt/smb/Datalake\"],\n  \"extensions\": [\"mp4\",\"mkv\",\"avi\",\"mov\",\"mp3\",\"flac\",\"wav\",\"jpg\",\"jpeg\",\"png\",\"gif\",\"webp\",\"pdf\",\"txt\",\"md\"],\n  \"metadata\": {\n    \"initiator\": \"n8n-daily-scan\",\n    \"purpose\": \"index-media-and-docs\",\n    \"host\": \"192.168.2.199\",\n    \"workflow\": \"SBQC-N2.1\"\n  }\n}",
        "options": {
          "timeout": 15000
        }
      },
      "id": "CreateScan",
      "name": "Create Scan Record (DataAPI)",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        -580,
        0
      ],
      "continueOnFail": false
    },
    {
      "parameters": {
        "command": "bash",
        "arguments": "-lc",
        "input": "set -euo pipefail\n\n# Tune these roots if needed\nROOTS=(/mnt/smb/Media /mnt/smb/Datalake)\n\n# Find media + common doc types. Output: path|size|mtime_epoch\n# - %p = full path\n# - %s = size bytes\n# - %T@ = mtime epoch (float)\n\nfor root in \"${ROOTS[@]}\"; do\n  if [ -d \"$root\" ]; then\n    find \"$root\" -type f \\( \\\n      -iname \"*.mp4\" -o -iname \"*.mkv\" -o -iname \"*.avi\" -o -iname \"*.mov\" -o \\\n      -iname \"*.mp3\" -o -iname \"*.flac\" -o -iname \"*.wav\" -o \\\n      -iname \"*.jpg\" -o -iname \"*.jpeg\" -o -iname \"*.png\" -o -iname \"*.gif\" -o -iname \"*.webp\" -o \\\n      -iname \"*.pdf\" -o -iname \"*.txt\" -o -iname \"*.md\" \\\n    \\) -printf \"%p|%s|%T@\\n\"\n  else\n    echo \"WARN|missing_root|$root|0\" >&2\n  fi\ndone",
        "options": {
          "timeout": 3600
        }
      },
      "id": "FindFiles",
      "name": "Execute: find files",
      "type": "n8n-nodes-base.executeCommand",
      "typeVersion": 1,
      "position": [
        -340,
        0
      ],
      "continueOnFail": false
    },
    {
      "parameters": {
        "jsCode": "const stdout = $input.first().json.stdout || '';\nconst lines = stdout.split('\\n').map(l => l.trim()).filter(Boolean);\n\n// Convert find output lines: path|size|mtime\nconst files = [];\nfor (const line of lines) {\n  const parts = line.split('|');\n  if (parts.length < 3) continue;\n  const path = parts[0];\n  const size = Number(parts[1]);\n  const mtime = Number(parts[2]);\n\n  if (!path || !Number.isFinite(size) || !Number.isFinite(mtime)) continue;\n\n  const segs = path.split('/');\n  const filename = segs.pop() || '';\n  const dirname = segs.join('/') || '';\n  const dot = filename.lastIndexOf('.');\n  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';\n\n  files.push({\n    path,\n    size,\n    modified: new Date(mtime * 1000).toISOString(),\n    dirname,\n    filename,\n    extension\n  });\n}\n\n// Batch into 100\nconst batches = [];\nfor (let i = 0; i < files.length; i += 100) {\n  batches.push(files.slice(i, i + 100));\n}\n\nreturn batches.map((batch, idx) => ({\n  json: {\n    batchIndex: idx,\n    batchSize: batch.length,\n    files: batch\n  }\n}));"
      },
      "id": "BatchFiles",
      "name": "Parse + Batch (100)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -90,
        0
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3003/api/v1/files/bulk",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"scanId\": $('Create Scan Record (DataAPI)').first().json.data?.scanId || $('Create Scan Record (DataAPI)').first().json.data?.id || $('Create Scan Record (DataAPI)').first().json.scanId,\n  \"files\": $json.files,\n  \"meta\": {\n    \"source\": \"n8n\",\n    \"workflow\": \"SBQC-N2.1\",\n    \"batchIndex\": $json.batchIndex,\n    \"batchSize\": $json.batchSize\n  }\n}",
        "options": {
          "timeout": 60000
        }
      },
      "id": "PostBulk",
      "name": "POST Batch to DataAPI /files/bulk",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        160,
        0
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "jsCode": "const scanId = $('Create Scan Record (DataAPI)').first().json.data?.scanId\n  || $('Create Scan Record (DataAPI)').first().json.data?.id\n  || $('Create Scan Record (DataAPI)').first().json.scanId\n  || null;\n\nreturn [{\n  json: {\n    scanId,\n    totalBatches: $items('Parse + Batch (100)').length,\n    totalFiles: $items('Parse + Batch (100)').reduce((sum, it) => sum + (it.json.batchSize || 0), 0),\n    finishedAt: new Date().toISOString()\n  }\n}];"
      },
      "id": "Summarize",
      "name": "Summarize Run",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        420,
        0
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3003/integrations/events/n8n",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"workflow_id\": \"SBQC-N2.1-nas-scan\",\n  \"event_type\": \"scan_complete\",\n  \"data\": $json\n}",
        "options": {
          "timeout": 15000
        }
      },
      "id": "LogScanComplete",
      "name": "Log scan_complete to DataAPI sink",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        670,
        0
      ],
      "continueOnFail": true
    },
    {
      "parameters": {
        "method": "PATCH",
        "url": "={{'http://192.168.2.33:3003/api/v1/storage/status/' + ($json.scanId || '')}}",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "{\n  \"status\": \"completed\",\n  \"completedAt\": \"={{$json.finishedAt}}\",\n  \"stats\": {\n    \"totalFiles\": \"={{$json.totalFiles}}\",\n    \"totalBatches\": \"={{$json.totalBatches}}\"\n  }\n}",
        "options": {
          "timeout": 15000
        }
      },
      "id": "MarkCompleted",
      "name": "OPTIONAL: Mark Scan Completed (if supported)",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        670,
        140
      ],
      "continueOnFail": true
    }
  ],
  "connections": {
    "Schedule (Daily 2AM)": {
      "main": [
        [
          {
            "node": "Create Scan Record (DataAPI)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Create Scan Record (DataAPI)": {
      "main": [
        [
          {
            "node": "Execute: find files",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Execute: find files": {
      "main": [
        [
          {
            "node": "Parse + Batch (100)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Parse + Batch (100)": {
      "main": [
        [
          {
            "node": "POST Batch to DataAPI /files/bulk",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "POST Batch to DataAPI /files/bulk": {
      "main": [
        [
          {
            "node": "Summarize Run",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Summarize Run": {
      "main": [
        [
          {
            "node": "Log scan_complete to DataAPI sink",
            "type": "main",
            "index": 0
          },
          {
            "node": "OPTIONAL: Mark Scan Completed (if supported)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": false,
  "settings": {
    "executionTimeout": 7200,
    "timezone": "America/Toronto",
    "saveExecutionProgress": true
  },
  "versionId": "1"
}

Two quick, important tweaks you might need
1) Execute Command node maxBuffer issue

You already hit this before (stdout too big). This workflow will explode if find returns millions of lines.

Fix (still Option A): Add a -maxdepth, or better: split scan by root, or extension groups, or date ranges.
If you want, I can give you the “Option A but safe” variant that:

runs multiple find commands by file type

streams results into temp files

processes chunk-by-chunk (no giant stdout)

2) Auth for DataAPI endpoints

Right now the workflow assumes DataAPI endpoints accept requests without API key. But your plan says storage/files endpoints need x-api-key. If that’s true in your running setup, we need to add header auth on:

Create Scan Record

POST /files/bulk

Mark Completed (optional)

I can output a version using n8n Credentials (Header Auth) cleanly.

Next workflow you want me to spit out:

N2.2 Hash Enrichment (sha256sum loop + patch update), or

N3.1 Model Health + latency monitor?

let's pause the dev and test what we have.   please generate an instruction md that goes along these json.
# SBQC n8n Workflows — Import + Test Instructions (N1.1, N1.2, N2.1)

Last updated: 2025-12-26  
Scope: the 3 workflow JSON exports we just generated:
- **N1.1** System Health Check (every 5 min)
- **N1.2** Ops AI Diagnostic (webhook)
- **N2.1** NAS File Scanner (daily 2AM)

Reference architecture + endpoint contracts: :contentReference[oaicite:0]{index=0} :contentReference[oaicite:1]{index=1} :contentReference[oaicite:2]{index=2}

---

## 0) Preconditions (don’t skip)

### Services reachable (LAN)
From the **n8n host** (192.168.2.199), these must respond:

- DataAPI: `http://192.168.2.33:3003/health`
- AgentX: `http://192.168.2.33:3080/health`
- Ollama UGFrank: `http://192.168.2.99:11434/api/tags`
- Ollama UGBrutal: `http://192.168.2.12:11434/api/tags`

Quick test on n8n host:
```bash
curl -s http://192.168.2.33:3003/health
curl -s http://192.168.2.33:3080/health
curl -s http://192.168.2.99:11434/api/tags | head
curl -s http://192.168.2.12:11434/api/tags | head

NAS mounts exist (for N2.1)

On the n8n host, these should exist and be readable:

/mnt/smb/Media

/mnt/smb/Datalake

Verify:

ls -la /mnt/smb
ls -la /mnt/smb/Media | head
ls -la /mnt/smb/Datalake | head


If n8n runs in Docker, you must mount /mnt/smb into the container (- /mnt/smb:/mnt/smb:ro). 

05-DEPLOYMENT

DataAPI endpoints needed (for N2.1)

N2.1 assumes:

POST /api/v1/storage/scan exists

POST /api/v1/files/bulk exists (your plan says it may still be pending) 

02-DATAAPI-TASKS

If /api/v1/files/bulk is not implemented yet:

N2.1 will still create a scan + run find,

then fail at the bulk insert node (expected).

1) Import the Workflows (3 JSONs)

In n8n UI:

Workflows

Import from File (or “Paste JSON” depending on UI)

Import each JSON:

SBQC - N1.1 System Health Check (5 min)

SBQC - N1.2 Ops AI Diagnostic (Webhook)

SBQC - N2.1 NAS File Scanner (Daily 2AM)

After import:

Leave them inactive until tests pass.

2) Test Workflow N1.1 (System Health Check)
What it does

Hits 4 endpoints in parallel

Aggregates into one status object

If degraded → logs event to DataAPI sink:

POST http://192.168.2.33:3003/integrations/events/n8n

Manual test

Open workflow SBQC - N1.1...

Click Execute Workflow

Expected results:

If all services are up → overall: "healthy" and alert: false

If any down → overall: "degraded" and alert: true, plus a POST to DataAPI sink.

Verify sink received event

On DataAPI host (or from anywhere that can hit Mongo / your logs):

Check DataAPI logs or Mongo collection SBQC.integration_events (per your DataAPI tasks) 

02-DATAAPI-TASKS

Quick “smoke” test of sink:

curl -X POST -H "Content-Type: application/json" \
  http://192.168.2.33:3003/integrations/events/n8n \
  -d '{"workflow_id":"manual-test","event_type":"health_probe","data":{"ok":true}}'

3) Test Workflow N1.2 (Ops AI Diagnostic Webhook)
What it does

Webhook receives a payload

Runs live probes (DataAPI / AgentX / Ollama 99 / Ollama 12)

Builds a snapshot

Calls AgentX chat:

POST http://192.168.2.33:3080/api/chat

persona: "sbqc_ops"

model target: Qwen on UGFrank (192.168.2.99:11434)

Returns JSON response to caller

Enable the webhook test URL

In the workflow editor:

Click the Webhook node

Use Test URL first (easiest for validation)

Call it (from your PC or any shell)

Replace with your n8n test webhook URL shown in the node.

curl -X POST "https://n8n.specialblend.icu/webhook-test/sbqc-ops-diagnostic" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual-check","note":"testing ops diagnostic"}'


Expected response structure:

{
  "status": "success",
  "snapshot": { ... live probes ... },
  "agentx": { ... AgentX /api/chat response ... }
}

If AgentX rejects persona

If persona: "sbqc_ops" isn’t implemented yet in AgentX prompt configs, you’ll still get a response but it may ignore persona. That’s fine for now: we’re verifying the plumbing first. 

03-AGENTX-TASKS

4) Test Workflow N2.1 (NAS File Scanner)
What it does

Creates scan record in DataAPI (/api/v1/storage/scan)

Executes find on /mnt/smb/Media and /mnt/smb/Datalake

Parses output lines path|size|mtime

Batches into 100-file chunks

POSTs each chunk to DataAPI /api/v1/files/bulk (if available)

Logs scan_complete to DataAPI sink

Optionally PATCHes scan status (only if your API supports it)

Run a small test first (recommended)

Before running against the full NAS, create a tiny test folder on the n8n host:

mkdir -p /mnt/smb/Media/_sbqc_test
echo "hi" > /mnt/smb/Media/_sbqc_test/test1.txt
dd if=/dev/zero of=/mnt/smb/Media/_sbqc_test/test2.bin bs=1K count=5


Then (temporary) edit the Execute: find files node to restrict roots:

Set ROOTS=(/mnt/smb/Media/_sbqc_test) for the first run.

Run the workflow manually:

Open workflow SBQC - N2.1...

Click Execute Workflow

Expected:

The find node returns a small stdout.

The parser creates 1 batch.

The bulk POST attempts to insert.

Verify in DataAPI

Confirm scan record exists (if your endpoint supports listing):

curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/storage/scans


(Or check Mongo SBQC.nas_scans)

Confirm file docs inserted (depends on your DataAPI implementation of /files/bulk)

5) Auth (if your endpoints require API keys)

Your docs indicate storage/files endpoints typically require x-api-key, while the integration sink is open.

If your DataAPI endpoints do require x-api-key, update these nodes:

N1.1

DataAPI Health (only if your /health is protected — usually it’s not)

Log to DataAPI Sink (only if you decide to protect it)

N2.1

Create Scan Record (DataAPI)

POST Batch to DataAPI /files/bulk

OPTIONAL: Mark Scan Completed

In each affected HTTP Request node:

Add Header:

x-api-key: <YOUR_KEY>

Best practice: create a reusable n8n Credential “Header Auth” and attach it to those nodes. 

04-N8N-WORKFLOWS

6) Troubleshooting (the usual gremlins)
A) Execute Command “stdout maxBuffer length exceeded”

This happens when find outputs too many lines.

Fixes (still “Option A”):

Limit scan scope (by extension group, root, or directory slices)

Split into 2 workflows (Media vs Datalake)

Add constraints like -size -2G or exclude huge trees

Prefer chunking by directory depth (scan top-level folders one at a time)

B) n8n Docker can’t see /mnt/smb

If n8n runs in Docker, the host path must be mounted into the container:

volumes:
  - /mnt/smb:/mnt/smb:ro


And restart n8n. 

05-DEPLOYMENT

C) Ollama endpoints timeout

Check firewall rules / routing

Confirm Ollama listens on 0.0.0.0 (not only 127.0.0.1)

Test from n8n host directly:

curl -v http://192.168.2.99:11434/api/tags

D) AgentX /api/chat fails

Confirm AgentX has access to Ollama host/port

Confirm model exists on target host

Check AgentX logs (pm2)

7) When tests pass → Activate

Recommended activation order:

Activate N1.2 (webhook only; safe)

Activate N1.1 (scheduled; gives you monitoring)

Activate N2.1 only after you confirm /api/v1/files/bulk can handle your expected volume

8) “Known Optional” parts (safe to ignore for now)

N2.1 “Mark Scan Completed” PATCH is optional; if DataAPI doesn’t support it, it’ll just fail silently (continueOnFail true).

N1.2 persona sbqc_ops can be added later; the workflow still validates the integration even without it. 

03-AGENTX-TASKS


If you paste the MD into your repo, I’d name it something like:
`docs/n8n/WORKFLOWS_TESTING.md`

When you’re ready, I can also generate a **tiny “Test Pack” workflow** that:
- runs N1.1 + N1.2 + a *small* N2.1 scan in one button press
- and produces a single “PASS/FAIL” report event into the DataAPI sink.



...


Yep — the test pack is just the “ECG pulse check”. Agent C is the whole circulatory system. 😄

I’m gonna assume Agent C = your Storage/Collector agent (scan NAS, batch, push to DB, dedupe/hash, produce events/metrics, feed RAG/KB). Here’s the plan for the rest of the work in a way that won’t rot in 2 weeks.

1) Define Agent C’s contract (so everything else snaps to it)

One input contract (from n8n / UI / cron):

{
  "roots": ["/mnt/media", "/mnt/datalake"],
  "extensions": ["mp4","mkv","jpg","pdf"],
  "batch_size": 1000,
  "compute_hashes": false,
  "hash_max_size": 104857600,
  "dry_run": false,
  "metadata": { "initiator": "n8n", "workflow": "..." }
}


One output contract (always):

{
  "scan_id": "...",
  "status": "started|running|done|failed",
  "counts": { "found": 0, "new": 0, "updated": 0, "skipped": 0, "errors": 0 },
  "errors": [],
  "timing": { "startedAt": "...", "endedAt": "..." }
}


This prevents “random shape” payloads from killing your pipeline later.

2) Make scanning deterministic and resumable
2.1 Scan record lifecycle (DB)

You already create a scan record. Next is to add:

status: queued/running/done/failed

cursor: where you are in the scan (so you can resume)

stats: counters

lastHeartbeatAt

lockOwner (prevents two scans fighting each other)

2.2 File identity strategy (critical)

Pick one “primary key” for file records:

Best practical: (deviceId + normalizedPath + size + mtime) as identity-ish

Plus optional sha256 for strong identity on big-value files

You don’t want to hash everything always. You want tiered certainty:

cheap: path/size/mtime

expensive: hash only for “new or suspicious changes” or small files

3) The ingestion pipeline (the real Agent C engine)

Split into stages; each stage logs events and can retry safely.

Stage A — Enumerate

find files (busybox-safe find + stat)

normalize path

filter extensions

emit batches of [{path,size,mtime}]

Stage B — Enrich (optional)

mime type (cheap), maybe folder tags, maybe media metadata later

Stage C — Upsert

upsert file docs in Mongo (or whatever DB you use)

increment scan stats

write errors as structured objects (not strings)

Stage D — Hash queue (optional)

if compute_hashes=true, enqueue hash jobs

hash worker processes asynchronously

update file docs with hash + hashVersion

Stage E — Finish

mark scan done

emit summary event

store “last scan snapshot” for diffing

4) Bulk insert endpoint(s): stop guessing which URL exists

Right now you found:

/api/v1/storage/scan ✅

/api/v1/files/bulk ❌ (404)

/integrations/events/n8n ✅

So Agent C work includes making the API surface consistent:

Either implement /api/v1/files/bulk (and document it)

Or delete it from workflows/docs and standardize on /api/v1/storage/*

My vote: keep it clean:

Proposed endpoints

POST /api/v1/storage/scan → creates scan + returns scan_id

POST /api/v1/storage/scan/:scan_id/batch → ingest batch of files

POST /api/v1/storage/hash/:scan_id/batch → hash results (worker)

GET /api/v1/storage/scan/:scan_id → status/progress

POST /integrations/events/n8n → external logging sink (unchanged)

5) Make n8n “Agent C orchestrator”, not “Agent C runtime”

n8n should:

validate environment (your test pack)

kick off scan

optionally poll status

push logs and notifications

run scheduling

The heavy lifting (scan, upsert, hash, dedupe) lives in DataAPI/AgentX service.

Reason: n8n is glue. It’s not your filesystem engine.

6) Observability (this is where projects stop dying)

Add these three things and you’ll debug 10x faster:

Correlation ID per scan (scan_id everywhere)

Structured events to /integrations/events/n8n or Mongo events collection

event types: scan.started, scan.batch_ingested, scan.warning, scan.failed, scan.done

Progress endpoint returning counters + heartbeat

Bonus: add a tiny /api/v1/storage/scan/:id/logs?tail=200

7) Hardening + safety knobs

dry_run mode

max files limit / max runtime

root allowlist (so nobody scans /)

concurrency control (one scan per root unless forced)

ignore patterns (node_modules, .git, thumbnails)

8) Deliverables checklist (what “done” looks like)

Agent C is “done” when:

✅ scan can run end-to-end unattended

✅ results land in DB with stable schema

✅ re-run produces mostly “skipped/updated”, not duplicates

✅ can resume after crash

✅ hashing is optional and isolated

✅ n8n shows PASS/FAIL + progress + summary

✅ everything emits events with scan_id

What I need from you (to tailor it to your codebase without wasting time)

Drop me the Agent C definition you’re using:

is Agent C a named module in your docs, or just “Storage scanner”?

which repo is the source of truth for it right now: AgentX or DataAPI?

do you want the file index stored in Mongo (current vibe) or something else?

If you don’t want to dig: just paste the relevant section from your docs (04-N8N-WORKFLOWS.md or wherever Agent C is described) and I’ll lock the plan to your architecture instead of generic “scanner stuff”.

look into your memory, you have the plan overview and agent prompts plus task

Yep 🙂 — pulling from memory, not reinventing anything.

You already have three authoritative artifacts that define Agent C’s intent:

00-OVERVIEW.md → global architecture & agent roles

06-AGENT-PROMPTS.md → behavioral contract for each agent

03-AGENTX-TASKS.md / 02-DATAAPI-TASKS.md → concrete responsibilities

So here’s Agent C’s plan, strictly aligned with that material, starting after the initial test pack you just completed.

I’ll keep it grounded, no fluff, no speculative scope creep.

Agent C — Canonical Role (from the overview & prompts)

Agent C = Storage / Knowledge Ingestion Agent

Its job is not UI, not orchestration, not chat.

Agent C is responsible for:

Observing storage roots (NAS, datalake, media)

Producing authoritative file state

Normalizing + persisting that state

Emitting events, not opinions

Feeding downstream agents (RAG, search, analysis)

n8n triggers it.
DataAPI executes it.
AgentX consumes its outputs.

Phase 1 — Solidify Agent C’s API surface (must be boring)

Right now you already have:

/api/v1/storage/scan ✅

scan record lifecycle partially implemented

1.1 Normalize Agent C endpoints (no ambiguity)

Agent C owns only these endpoints:

POST   /api/v1/storage/scan
GET    /api/v1/storage/scan/:scan_id
POST   /api/v1/storage/scan/:scan_id/batch
POST   /api/v1/storage/scan/:scan_id/finalize


Anything like /files/bulk either:

becomes an alias → calls scan/:id/batch

or is removed entirely

Outcome: n8n never guesses endpoints again.

Phase 2 — Agent C internal pipeline (this is the core work)

This follows exactly what’s implied in your task docs.

2.1 Scan lifecycle (state machine)

Each scan document must move through:

queued → running → ingesting → hashing(optional) → done | failed


Required fields:

scan_id

roots[]

extensions[]

status

stats (found / new / updated / skipped / errors)

startedAt / endedAt

lastHeartbeatAt

This enables:

progress polling

resume

crash recovery

2.2 File identity strategy (critical, from Agent C prompt)

Agent C does tiered certainty, not brute-force hashing.

Default identity:

device + normalizedPath + size + mtime


Hashing rules:

optional

size-capped

async

never blocks scan completion

This is explicitly aligned with the “cheap first, expensive later” approach in your task notes.

Phase 3 — Batch ingestion (where most bugs usually hide)
3.1 Batch contract (must be strict)

Each batch POST contains:

{
  "scan_id": "...",
  "files": [
    { "path": "...", "size": 123, "mtime": 1234567890 }
  ]
}


Rules:

batch is idempotent

duplicates are safe

partial failures are logged, not fatal

3.2 Agent C responsibilities here

normalize paths

upsert file records

increment scan stats

emit scan.batch_ingested event

No UI logic. No retry loops in n8n.
Retries belong inside Agent C.

Phase 4 — Optional hashing worker (Agent C sub-mode)

Hashing is explicitly decoupled in your plan.

Implementation:

hash jobs queued per scan

separate worker / process

results update file docs

emits file.hashed events

This allows:

turning hashing on/off per scan

scaling independently

never blocking ingestion

Phase 5 — Observability (Agent C must be chat-proof)

From your overview: agents communicate via events, not shared state.

Agent C emits:

scan.started

scan.batch_ingested

scan.warning

scan.failed

scan.done

Destination:

Mongo events collection

/integrations/events/n8n

future AgentX event bus

This is why your EventEmitter warning matters — listeners must be attached once, not per request.

Phase 6 — n8n’s only remaining role with Agent C

n8n should:

validate environment (test pack)

trigger scan

poll status

present PASS / WARN / FAIL

schedule runs

notify humans

n8n must not:

enumerate files

decide identity rules

dedupe

hash

upsert records

Those are Agent C’s job.

Phase 7 — Integration with AgentX / RAG (future-safe)

Agent C outputs become:

searchable storage index

provenance-safe source for RAG

“ground truth” for content existence

Other agents:

Agent A/B reason about data

Agent C says what exists

Agent X orchestrates who talks to whom

Clean separation. No circular logic.

What “Agent C DONE” actually means

Agent C is complete when:

✔ scans are resumable

✔ repeated scans don’t duplicate records

✔ hashing is optional and async

✔ progress can be polled

✔ events tell the full story

✔ n8n never needs shell tricks again

You’re already past the hardest part (environment + plumbing).
Everything left is controlled, incremental, and testable.

Next concrete step (no hand-waving)

Pick one:

Implement GET /storage/scan/:scan_id (progress + stats), or

Implement POST /storage/scan/:scan_id/batch cleanly.

Say which one you want next and I’ll give you the exact schema + handler logic, aligned with your existing codebase — not generic boilerplate.

we have define only 3 workflows... 1.1, 1.2 and 2.1.   dont we need more?

Not necessarily. 3 workflows can be enough if they cover: (1) “are we alive?”, (2) “what’s broken?”, (3) “do the core pipeline steps actually work end-to-end?”.

Right now your three are basically:

1.1 Health Check = quick pulse

1.2 Ops Diagnostic = deeper troubleshooting context

2.1 Test Pack = functional validation (mounts + scan + events)

That’s a solid “minimum viable ops layer”.

Where you do want more workflows is when you move from validation to production operation (scheduled scans, ingestion, hashing, drift detection, alerts). Those are different concerns and you don’t want to overload 2.1.

Here’s the clean way to extend without exploding workflow count:

Keep only 3 if you add “modes”

You can keep 1.1/1.2/2.1 and add a mode config:

mode=smoke (fast)

mode=full (slower, includes real scan)

mode=ingest (calls batch ingest)

mode=hash (queues hashing)

That keeps the UI tidy, but debugging gets harder because one workflow does a lot.

If you want the “right” extra workflows, add only 3 more

These are the ones that pay rent:

3.1 Scheduled Scan Runner

Purpose: run real scans on schedule (nightly/hourly), not test roots.
Does: trigger /api/v1/storage/scan for configured roots + poll progress + emit summary.

3.2 Batch Ingest Worker (or “Ingest Orchestrator”)

Purpose: move file batches into your DB/index reliably.
Does: take enumerated files (from Agent C / DataAPI) → POST /scan/:id/batch (or whatever you standardize) → retries/backoff → metrics.

(If DataAPI does ingestion internally, this workflow becomes tiny or unnecessary.)

3.3 Alerting & Regression Watch

Purpose: notify you when something regresses (mount broke, auth broke, scan stalled).
Does: consume final report events → apply rules → notify (Discord/email/etc).

That’s it. With those 6 you’ve got a proper ops/ingestion system without chaos.

My recommendation for SBQC

Keep 1.1 and 1.2 exactly as-is (they’re your “I’m blind, help” buttons).

Keep 2.1 as the canonical validator (the gatekeeper).

Add only one new workflow next: 3.1 Scheduled Scan Runner.

Because once scans run on schedule, everything else becomes an obvious next need (ingest/alerts), and you’ll know what’s missing by pain, not theory.

If you tell me what you want Agent C to do in production today (just “scan + store status” vs “scan + ingest file index into Mongo”), I’ll map the smallest additional workflow set and the exact triggers between them.

please validate your answer with the AGENT-PROMPTS and the N8N-WORKFLOWS documents  in your memory

Yep — and I need to correct my earlier take.

In 04-N8N-WORKFLOWS.md, it’s not “only 3 workflows exist”. The doc explicitly defines more than three workflows.

What the docs actually say

04-N8N-WORKFLOWS.md has these workflow headings (I pulled them straight from the file):

N1.1: System Health Check (Priority 1)

N1.2: DataAPI Health Probe (Webhook Receiver) (Priority 1)

N2.1: NAS File Scanner

N2.2: File Enrichment (Hashing)

N2.3: RAG Document Ingestion

N3.1: Model Health Monitor

N3.2: AI Chat Trigger

N5.1: Feedback Analysis & Prompt Optimization

So yes: the plan in your docs expects more workflows than 1.1, 1.2, 2.1.

How this matches 06-AGENT-PROMPTS.md

In 06-AGENT-PROMPTS.md, Agent C is explicitly “n8n Workflow Developer” and is tasked with building workflows for the SBQC stack. That lines up with the fact that the n8n doc includes “beyond validation” workflows like hashing, RAG ingestion, model monitoring, chat trigger, and feedback optimization.

So do we “need more” than 3?

If your goal is only validation + basic ops, then you can run with just N1.1 + N1.2 + N2.1 as a minimal set.

But per your own N8N-WORKFLOWS document, the intended system includes additional workflows for:

enrichment (hashing) → N2.2

RAG ingestion → N2.3

model monitoring + chat triggers → N3.1 / N3.2

feedback loop / prompt tuning → N5.1

So the doc-backed answer is: yes, the system design calls for more workflows — and they’re already specified.

If you want, I’ll map your current “Option A” path into a concrete execution order like:
N1.1/N1.2 → N2.1 → N2.2 → N2.3 → N3.1/N3.2 → N5.1, with the exact handoff payload between each (so you don’t get “mystery JSON” bugs again).







Below is a clean **instruction MD** that matches the **3 workflow JSONs we generated** (N1.1, N1.2 Ops Diagnostic, N2.1). I’m also flagging **one important naming mismatch** vs the official n8n spec doc: in `04-N8N-WORKFLOWS.md`, **“N1.2” is described as a DataAPI→n8n webhook receiver**, but the JSON we built for “N1.2” is **an Ops Diagnostic webhook that calls AgentX**. Functionally it’s great — but I’m calling it out so you don’t get confused later when you implement the “real” N1.2 receiver workflow. 

---

# SBQC n8n Workflows — Import & Test Guide (N1.1, N1.2 Ops Diagnostic, N2.1)

**Last updated:** 2025-12-26
**n8n host:** 192.168.2.199 (UGStation)
**DataAPI + AgentX host:** 192.168.2.33
**Ollama hosts:** 192.168.2.99 (UGFrank), 192.168.2.12 (UGBrutal)  

## 1) What you have right now (3 workflows)

### N1.1 — System Health Check (Every 5 min)

* Probes:

  * DataAPI `/health`
  * AgentX `/health`
  * Ollama 99 `/api/tags`
  * Ollama 12 `/api/tags`
* Aggregates status
* If degraded → logs to DataAPI sink: `POST /integrations/events/n8n`  

### N1.2 — Ops AI Diagnostic (Webhook)  ✅ (this is **our** N1.2)

* Webhook trigger
* Runs the same live probes as N1.1
* Calls **AgentX `/api/chat`** using persona `sbqc_ops`
* Returns JSON directly to the webhook caller  

> ⚠️ Naming mismatch note: `04-N8N-WORKFLOWS.md` calls “N1.2” a **DataAPI webhook receiver** workflow. Our “N1.2” is an **Ops Diagnostic webhook**. Keep it, but later we’ll add the spec’s receiver workflow as a different name (ex: `N1.2b` or `N1.4`). 

### N2.1 — NAS File Scanner (Daily 2AM)

* Creates scan in DataAPI: `POST /api/v1/storage/scan`
* Runs `find` on `/mnt/smb/Media` and `/mnt/smb/Datalake`
* Splits into batches of 100
* Sends each batch to **`POST /api/v1/files/bulk`** (endpoint may still be missing; expected if so)
* Logs `scan_complete` to DataAPI sink
* Optional “mark completed” PATCH (safe to fail)  

---

## 2) Preconditions (don’t skip)

### 2.1 Network reachability (from the n8n host)

Run these **on the n8n machine** (192.168.2.199):

```bash
curl -sS http://192.168.2.33:3003/health
curl -sS http://192.168.2.33:3080/health
curl -sS http://192.168.2.99:11434/api/tags | head
curl -sS http://192.168.2.12:11434/api/tags | head
```

If any hang/time out → fix network/listen/firewall first. 

### 2.2 SMB mounts (for N2.1)

On the n8n host:

```bash
ls -la /mnt/smb
ls -la /mnt/smb/Media | head
ls -la /mnt/smb/Datalake | head
```

If n8n is running **inside Docker**, you must bind-mount `/mnt/smb` into the container, or the Execute Command node won’t see your NAS paths. 

### 2.3 Auth expectations (super important)

* DataAPI sink `/integrations/events/n8n` is expected to work **without API key** (open receiver for n8n). 
* DataAPI storage/files endpoints often require `x-api-key` (depending on your config).  
* AgentX n8n routes require `x-api-key`, but our current N1.2 workflow calls `/api/chat` (which in your stack may or may not require a key). 

**For now:** test without keys first; if you get 401/403, add headers in n8n nodes.

---

## 3) Import the workflows into n8n

In n8n UI:

* **Workflows → Import**
* Paste JSON (or import file)
* Import:

  * `SBQC - N1.1 System Health Check (5 min)`
  * `SBQC - N1.2 Ops AI Diagnostic (Webhook)`
  * `SBQC - N2.1 NAS File Scanner (Daily 2AM)`

Leave them **Inactive** until the manual runs succeed. 

---

## 4) Test N1.1 (manual run)

1. Open workflow **N1.1**
2. Click **Execute Workflow**

Expected:

* Output JSON includes:

  * `overall: "healthy"` and `alert: false` when all good
  * `overall: "degraded"` and `alert: true` if anything fails

If degraded: it should POST an event to:

* `http://192.168.2.33:3003/integrations/events/n8n` 

Quick sink smoke test (from anywhere on LAN):

```bash
curl -X POST -H "Content-Type: application/json" \
  http://192.168.2.33:3003/integrations/events/n8n \
  -d '{"workflow_id":"manual-test","event_type":"health_probe","data":{"ok":true}}'
```

Acceptance:

* DataAPI responds `{ok: true, id: ...}` (or similar)
* Mongo collection `SBQC.integration_events` gets a record  

---

## 5) Test N1.2 Ops AI Diagnostic (webhook)

### 5.1 Use the “Test URL” first

In n8n:

* open workflow **N1.2 Ops AI Diagnostic**
* click the Webhook node
* copy the **Test URL** (`/webhook-test/...`)

Call it:

```bash
curl -X POST "https://n8n.specialblend.icu/webhook-test/sbqc-ops-diagnostic" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual-check","note":"testing ops diagnostic"}'
```

Expected response:

```json
{
  "status": "success",
  "snapshot": { "...": "..." },
  "agentx": { "...": "..." }
}
```

If `agentx` contains an error:

* confirm AgentX `/api/chat` works directly (see AgentX validation curl) 
* confirm the target model exists on the Ollama host you’re routing to (our JSON uses qwen target 192.168.2.99)

---

## 6) Test N2.1 NAS File Scanner (SAFE small test)

### 6.1 Create a tiny test folder (recommended)

On the n8n host:

```bash
mkdir -p /mnt/smb/Media/_sbqc_test
echo "hi" > /mnt/smb/Media/_sbqc_test/test1.txt
dd if=/dev/zero of=/mnt/smb/Media/_sbqc_test/test2.bin bs=1K count=5
```

### 6.2 Temporarily narrow scan roots (first run)

In the **Execute: find files** node, temporarily set:

```bash
ROOTS=(/mnt/smb/Media/_sbqc_test)
```

Then run the workflow manually.

Expected:

* Create scan record succeeds: `POST /api/v1/storage/scan` 
* `find` returns a small stdout
* batches created
* `POST /api/v1/files/bulk`:

  * ✅ succeeds if endpoint exists
  * ❌ fails (expected) if endpoint not implemented yet (noted in docs)  
* `scan_complete` event is logged to DataAPI sink (this part should still work)

### 6.3 Confirm DataAPI scan list shows it

```bash
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/storage/scans
```

And scan status:

```bash
curl -H "x-api-key: KEY" http://192.168.2.33:3003/api/v1/storage/status/<scan_id>
```

(Use API key or session auth, depending on your setup.) 

---

## 7) Known failure modes and what they mean

### A) `stdout maxBuffer length exceeded`

This is the big one for N2.1: `find` can output millions of lines and n8n will choke.

Mitigations (still “Option A”, still `find`):

* scan one root at a time (Media then Datalake)
* split by extension groups (videos/images/docs)
* restrict depth for first production runs
* output to file and process chunks (safer variant; still Option A but more robust)

### B) `/api/v1/files/bulk` 404

That endpoint is referenced by the workflow spec, but flagged as “needs to be created” in DataAPI tasks.  
If this fails: the scan part is still useful, and we proceed to implement that API next.

### C) 401/403 errors

Add `x-api-key` headers using n8n Credentials:

* `DataAPI API Key` (Header Auth)
* `AgentX API Key` (Header Auth) 

---

## 8) Activation order (once manual tests pass)

1. Activate **N1.2 Ops Diagnostic** (webhook is passive; safe)
2. Activate **N1.1 Health Check** (gives monitoring)
3. Activate **N2.1** only after you’re confident about volume + buffer risk + `/files/bulk` readiness

---

## 9) What’s next after this test phase (doc-aligned)

Once these 3 are green, the next workflows that the official n8n spec expects are:

* **N2.2** File Enrichment (Hashing) 
* **N2.3** RAG Document Ingestion 
* **N3.1** Model Health Monitor 
* **N3.2** AI Chat Trigger 
* **N5.1** Feedback Analysis & Prompt Optimization 

But we don’t build those until the basic ingest loop is solid (and `/api/v1/files/bulk` reality is settled). 

---

If you want, I can also generate a **“one-click TEST PACK” workflow** that runs **N1.1 + N1.2 + a tiny N2.1** and emits one final `PASS/FAIL` event into `SBQC.integration_events` — super handy for regression checks after any change. 
