# Benchmark API - Enhanced Features

**Version:** 2.0 (January 2026)
**Base URL:** `/api/benchmark`

This document describes the enhanced benchmark API with rich analytics, real-time stats, and configuration presets for an informative UI experience.

---

## Table of Contents

1. [Overview](#overview)
2. [New Endpoints](#new-endpoints)
3. [Enhanced Data Models](#enhanced-data-models)
4. [Use Cases & UI Integration](#use-cases--ui-integration)
5. [Example Responses](#example-responses)

---

## Overview

The enhanced benchmark system provides:

- **Detailed Execution Metrics** - Duration, throughput, resource usage
- **Time-Series Analytics** - Performance trends over time
- **Batch Comparison** - Side-by-side batch analysis
- **Real-Time Statistics** - Live progress for active batches
- **Configuration Presets** - Common test scenarios
- **Tag-Based Organization** - Categorize and filter batches

---

## New Endpoints

### 1. GET /api/benchmark/active-stats

Get real-time statistics for all currently running batches.

**Use Case:** Dashboard live updates, progress monitoring

**Query Parameters:** None

**Response:**
```json
{
  "status": "success",
  "data": {
    "active_batches": 2,
    "total_tests_running": 150,
    "total_completed": 45,
    "total_pending": 105,
    "estimated_completion_time": 180000,
    "batches": [
      {
        "batch_id": "67787a1b2c3d4e5f6g7h8i9j",
        "run_name": "Llama 3.2 Evaluation",
        "progress": 30,
        "status": "running",
        "completed": 45,
        "total": 150,
        "elapsed_ms": 120000,
        "eta_ms": 180000,
        "judge_progress": 25
      }
    ]
  }
}
```

**Polling Recommendation:** Poll every 2-5 seconds for real-time UI updates

---

### 3. GET /api/benchmark/judge-leaderboard

Get performance rankings and activity stats for Judge Models (LLM-as-a-Judge).

**Use Case:** "The Courthouse" dashboard, evaluating judge reliability and speed.

**Query Parameters:** None

**Response:**
```json
{
  "status": "success",
  "data": {
    "leaderboard": [
      {
        "judge_model": "llama3:8b",
        "judge_host": "http://localhost:11434",
        "count": 150,
        "avg_latency": 4500,
        "success_rate": 98.5,
        "avg_explanation_len": 320,
        "score_distribution": { "1": 2, "5": 10, "10": 50 }
      }
    ],
    "activity": [
      {
        "model": "deepseek-coder:6.7b",
        "judge_model": "llama3:8b",
        "quality_score": 9,
        "timestamp": "2026-01-04T10:00:00Z"
      }
    ]
  }
}
```

---

### 4. GET /api/benchmark/trends

Get time-series performance trends for model analysis.

**Use Case:** Charts showing model performance over time

**Query Parameters:**
- `model` (optional) - Filter by specific model (omit for all models)
- `days` (optional) - Number of days to look back (default: 7)
- `groupBy` (optional) - `'hour'` or `'day'` (default: 'day')

**Example Request:**
```
GET /api/benchmark/trends?model=llama3.2:3b&days=14&groupBy=day
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "trends": [
      {
        "_id": { "year": 2026, "month": 1, "day": 1 },
        "avg_latency": 1250,
        "avg_tokens_per_sec": 125.5,
        "avg_quality": 82.3,
        "avg_composite": 78.9,
        "tests_count": 45,
        "total_tokens": 12500
      },
      {
        "_id": { "year": 2026, "month": 1, "day": 2 },
        "avg_latency": 1180,
        "avg_tokens_per_sec": 132.1,
        "avg_quality": 84.1,
        "avg_composite": 81.2,
        "tests_count": 52,
        "total_tokens": 14300
      }
    ],
    "period": { "days": 14, "groupBy": "day" },
    "model": "llama3.2:3b"
  }
}
```

**UI Integration:**
- Use for line charts showing performance trends
- Display separate lines for latency, quality, composite scores
- Allow user to select date range and grouping

---

### 3. POST /api/benchmark/compare-batches

Compare multiple batch runs side-by-side.

**Use Case:** A/B testing, configuration comparison, regression detection

**Request Body:**
```json
{
  "batch_ids": [
    "67787a1b2c3d4e5f6g7h8i9j",
    "77887b2c3d4e5f6g7h8i9j0k"
  ]
}
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "comparison": [
      {
        "batch_id": "67787a1b2c3d4e5f6g7h8i9j",
        "run_name": "Llama 3.2 - Baseline",
        "models": ["llama3.2:3b"],
        "status": "completed",
        "total_tests": 100,
        "completed": 100,
        "success_rate": "98.0%",
        "execution_metrics": {
          "total_duration_ms": 180000,
          "generation_duration_ms": 120000,
          "judging_duration_ms": 60000,
          "avg_test_duration_ms": 1200,
          "avg_judge_duration_ms": 600,
          "tests_per_minute": 50,
          "total_tokens_generated": 25000,
          "total_tokens_per_sec_avg": "125.5"
        },
        "config_snapshot": {
          "agentx_version": "1.3.2",
          "node_version": "v20.10.0",
          "os_platform": "linux",
          "cpu_count": 16
        },
        "created_at": "2026-01-03T10:00:00Z",
        "completed_at": "2026-01-03T10:30:00Z",
        "quality_scoring": true
      }
    ],
    "stats": {
      "avg_duration_ms": 180000,
      "avg_tests_per_minute": 50,
      "avg_tokens_generated": 25000,
      "fastest_batch": {
        "id": "67787a1b2c3d4e5f6g7h8i9j",
        "name": "Llama 3.2 - Baseline",
        "duration": 180000
      },
      "slowest_batch": {
        "id": "77887b2c3d4e5f6g7h8i9j0k",
        "name": "Llama 3.2 - Optimized",
        "duration": 200000
      }
    }
  }
}
```

**UI Integration:**
- Side-by-side comparison table
- Highlight improvements (green) and regressions (red)
- Show delta percentages between batches

---

### 4. GET /api/benchmark/stats-by-tag

Get aggregated statistics grouped by tags.

**Use Case:** Organizational views, filtering by test type

**Query Parameters:** None

**Response:**
```json
{
  "status": "success",
  "data": {
    "tags": [
      {
        "tag": "production",
        "count": 15,
        "completed": 12,
        "avg_duration_ms": 210000,
        "avg_success_rate": "97.5%"
      },
      {
        "tag": "experimental",
        "count": 8,
        "completed": 7,
        "avg_duration_ms": 180000,
        "avg_success_rate": "92.3%"
      },
      {
        "tag": "nightly",
        "count": 30,
        "completed": 28,
        "avg_duration_ms": 195000,
        "avg_success_rate": "96.1%"
      }
    ],
    "total_tags": 3
  }
}
```

**UI Integration:**
- Tag filter dropdown in batch list
- Tag-based statistics cards
- Tag badges in batch rows

---

### 5. GET /api/benchmark/presets

Get configuration presets for common test scenarios.

**Use Case:** Quick start, guided configuration

**Query Parameters:** None

**Response:**
```json
{
  "status": "success",
  "data": {
    "presets": [
      {
        "id": "quick-test",
        "name": "Quick Test",
        "description": "Fast validation test with simple prompts",
        "config": {
          "levels": [1, 2],
          "quality_scoring": false,
          "judge_config": null
        },
        "recommended_for": "Initial model validation, quick checks",
        "estimated_duration": "2-5 minutes"
      },
      {
        "id": "standard-benchmark",
        "name": "Standard Benchmark",
        "description": "Balanced test across all levels with quality scoring",
        "config": {
          "levels": [1, 2, 3, 4, 5],
          "quality_scoring": true,
          "judge_config": {
            "concurrency": 2,
            "judge_same_host": false
          }
        },
        "recommended_for": "Regular model evaluation",
        "estimated_duration": "15-30 minutes"
      }
    ]
  }
}
```

**UI Integration:**
- Preset selector dropdown
- Apply preset button to populate form
- Display preset description and estimated duration

---

## Enhanced Data Models

### BenchmarkBatch (Enhanced)

**New Fields:**

```typescript
{
  // ... existing fields ...

  // Detailed execution metrics
  execution_metrics: {
    total_duration_ms: number | null;
    generation_duration_ms: number | null;
    judging_duration_ms: number | null;
    avg_test_duration_ms: number | null;
    avg_judge_duration_ms: number | null;
    tests_per_minute: number | null;
    peak_memory_mb: number | null;
    total_tokens_generated: number;
    total_tokens_per_sec_avg: string | null;
  };

  // Configuration snapshot (reproducibility)
  config_snapshot: {
    ollama_version?: string;
    agentx_version: string;
    node_version: string;
    os_platform: string;
    cpu_count: number;
  };

  // Tags for categorization
  tags: string[];

  // Notes/description
  description: string;
}
```

---

## Use Cases & UI Integration

### 1. Real-Time Dashboard

**Endpoint:** `GET /api/benchmark/active-stats`

**UI Components:**
- Active batches counter
- Overall progress bar (total_completed / total_tests_running)
- ETA countdown timer
- Live batch list with individual progress bars

**Polling Strategy:**
```javascript
// Poll every 3 seconds when batches are active
const pollActiveStats = async () => {
  const response = await fetch('/api/benchmark/active-stats');
  const data = await response.json();

  if (data.data.active_batches === 0) {
    // Stop polling if no active batches
    clearInterval(pollInterval);
  }

  updateDashboard(data.data);
};

const pollInterval = setInterval(pollActiveStats, 3000);
```

---

### 2. Performance Trends Chart

**Endpoint:** `GET /api/benchmark/trends?model=llama3.2:3b&days=7&groupBy=day`

**UI Components:**
- Line chart with Chart.js or similar
- Date range selector (7d, 14d, 30d)
- Model selector dropdown
- Multiple metrics toggle (latency, quality, composite)

**Example Chart.js Integration:**
```javascript
const response = await fetch('/api/benchmark/trends?model=llama3.2:3b&days=7');
const { data } = await response.json();

const chartData = {
  labels: data.trends.map(t => `${t._id.month}/${t._id.day}`),
  datasets: [
    {
      label: 'Avg Latency (ms)',
      data: data.trends.map(t => t.avg_latency),
      borderColor: '#7CF0FF',
      yAxisID: 'y'
    },
    {
      label: 'Avg Quality Score',
      data: data.trends.map(t => t.avg_quality),
      borderColor: '#00FF9F',
      yAxisID: 'y1'
    }
  ]
};
```

---

### 3. Batch Comparison View

**Endpoint:** `POST /api/benchmark/compare-batches`

**UI Components:**
- Batch selector (multi-select)
- Comparison table with columns:
  - Metric
  - Batch 1 Value
  - Batch 2 Value
  - Delta (with color coding)
- Performance difference highlights

**Example Table:**
```
┌────────────────────────┬─────────────┬─────────────┬────────────┐
│ Metric                 │ Baseline    │ Optimized   │ Delta      │
├────────────────────────┼─────────────┼─────────────┼────────────┤
│ Total Duration         │ 180s        │ 150s        │ ↓ 16.7% ✅ │
│ Avg Test Duration      │ 1200ms      │ 1000ms      │ ↓ 16.7% ✅ │
│ Tests per Minute       │ 50          │ 60          │ ↑ 20.0% ✅ │
│ Success Rate           │ 98.0%       │ 99.0%       │ ↑ 1.0% ✅  │
│ Tokens Generated       │ 25000       │ 26000       │ ↑ 4.0%     │
└────────────────────────┴─────────────┴─────────────┴────────────┘
```

---

### 4. Configuration Wizard

**Endpoint:** `GET /api/benchmark/presets`

**UI Flow:**
1. Display preset cards with descriptions
2. User selects preset
3. Form auto-fills with preset configuration
4. User can customize before submitting

**Example UI:**
```
┌─────────────────────────────────────────────────────────┐
│ Select a Test Preset                                    │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  [ Quick Test ]           Estimated: 2-5 minutes        │
│  Fast validation with simple prompts                    │
│  ✓ Levels: 1-2  ✗ Quality Scoring                      │
│  [Select]                                                │
│                                                          │
│  [ Standard Benchmark ]   Estimated: 15-30 minutes      │
│  Balanced test across all levels                        │
│  ✓ Levels: 1-5  ✓ Quality Scoring                      │
│  [Select]                                                │
│                                                          │
│  [ Deep Quality ]         Estimated: 30-60 minutes      │
│  Comprehensive quality analysis                          │
│  ✓ Levels: 3-5  ✓ Quality Scoring  ✓ Extended Timeout  │
│  [Select]                                                │
└─────────────────────────────────────────────────────────┘
```

---

### 5. Tag-Based Filtering

**Endpoint:** `GET /api/benchmark/stats-by-tag`

**UI Components:**
- Tag filter chips
- Tag statistics summary cards
- Filtered batch list

**Example:**
```javascript
// Fetch tag stats
const response = await fetch('/api/benchmark/stats-by-tag');
const { data } = await response.json();

// Render tag chips
data.tags.forEach(tagStat => {
  renderTagChip({
    name: tagStat.tag,
    count: tagStat.count,
    avgSuccessRate: tagStat.avg_success_rate,
    onClick: () => filterBatchesByTag(tagStat.tag)
  });
});
```

---

## Example Responses

### Enhanced Batch Details

**Endpoint:** `GET /api/benchmark/batch/:id`

**Query Parameters:**
- `include_heavy` (optional, boolean-like: `1|true|yes`) - Include heavy per-result fields (`judge_raw_response`, `hardware_snapshot`, `execution_settings`, `warmup`, `judge_warmup`). Default is compact mode.
- `result_limit` (optional, integer, default `500`, max `5000`) - Number of results to return in this response.
- `result_offset` (optional, integer, default `0`) - Offset into result list for pagination.
- `include_all_results` (optional, boolean-like: `1|true|yes`) - Return all results and ignore pagination limits.

**Response includes:**
```json
{
  "status": "success",
  "data": {
    "run_name": "Llama 3.2 Full Benchmark",
    "status": "completed",
    "tags": ["production", "weekly"],
    "description": "Weekly production model evaluation",

    "execution_metrics": {
      "total_duration_ms": 180000,
      "generation_duration_ms": 120000,
      "judging_duration_ms": 60000,
      "avg_test_duration_ms": 1200,
      "avg_judge_duration_ms": 600,
      "tests_per_minute": 50,
      "peak_memory_mb": 2048,
      "total_tokens_generated": 25000,
      "total_tokens_per_sec_avg": "125.5"
    },

    "config_snapshot": {
      "agentx_version": "1.3.2",
      "node_version": "v20.10.0",
      "os_platform": "linux",
      "cpu_count": 16
    },

    "progress": 100,
    "judge_progress": 100,
    "success_rate": "98.0%",
    "_countMismatch": false,

    "results": [ /* array of test results */ ]
  }
}
```

**Counter Reconciliation Behavior:**
- `completed` and `failed` counters are reconciled from persisted results when drift is detected.
- `_countMismatch: true` indicates reconciliation happened on this response.

**Compact vs Heavy Payload:**
- Default (compact): excludes heavy diagnostics to reduce payload size on large batches.
- `?include_heavy=1`: includes heavy diagnostics for deep debugging.

**Result Pagination:**
- Default responses are paginated for large batches and include `results_meta`.
- Use `result_limit`/`result_offset` for paging.
- Use `include_all_results=1` only when full payload is required.

---

### Batch Start Conflict (Single Active Batch Guard)

**Endpoint:** `POST /api/benchmark/batch`

Only one active benchmark batch is allowed at a time.

**Conflict Response (409):**
```json
{
  "status": "error",
  "error": "Another batch is already running",
  "active_batch": {
    "id": "67787a1b2c3d4e5f6g7h8i9j",
    "run_name": "Weekly Regression",
    "status": "running",
    "progress": 42,
    "inactive_seconds": 18,
    "is_stuck": false,
    "started_at": "2026-02-09T12:00:00.000Z"
  },
  "message": "Batch \"Weekly Regression\" is currently running (42% complete). Please wait for it to finish or stop it first."
}
```

Notes:
- This is enforced by both a pre-check and an atomic DB-level uniqueness guard to close race windows.
- If `inactive_seconds > 300`, `is_stuck` becomes `true` and clients can call recovery endpoints.

---

## UI Best Practices

### 1. Progressive Disclosure
- Show summary metrics first
- Expand for detailed metrics on click
- Use collapsible sections for execution_metrics

### 2. Visual Feedback
- Use color coding for status (green=completed, blue=running, red=failed)
- Show progress bars for active batches
- Highlight regressions in comparisons

### 3. Performance
- Cache preset configurations
- Implement virtual scrolling for large result lists
- Debounce trend chart updates

### 4. Accessibility
- Use semantic HTML for statistics
- Provide text alternatives for charts
- Keyboard navigation for preset selection

---

## Migration Guide

### For Existing UI Code

**Before:**
```javascript
// Old endpoint
const batch = await fetch(`/api/benchmark/batch/${id}`);
// Limited metrics available
```

**After:**
```javascript
// Same endpoint, enhanced data
const batch = await fetch(`/api/benchmark/batch/${id}`);
const data = await batch.json();

// Now includes:
// - execution_metrics
// - config_snapshot
// - tags
// - description
```

**No breaking changes** - all new fields are additions, existing fields unchanged.

---

## Summary

### New Endpoints (6 total)
1. `/active-stats` - Real-time progress
2. `/trends` - Time-series analytics
3. `/compare-batches` - Batch comparison
4. `/stats-by-tag` - Tag-based statistics
5. `/presets` - Configuration templates

### Enhanced Data
- Detailed execution metrics (9 new metrics)
- System configuration snapshot
- Tag support
- Description field

### UI Capabilities Enabled
- Real-time dashboards
- Performance trend charts
- Side-by-side comparisons
- Quick-start wizards
- Tag-based organization

---

**Documentation Version:** 2.1
**Last Updated:** February 9, 2026
**Feedback:** Report issues at github.com/anthropics/agentx/issues
