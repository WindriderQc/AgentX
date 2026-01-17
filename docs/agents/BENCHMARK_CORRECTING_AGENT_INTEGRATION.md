# Benchmark Correcting Agent - Integration Guide

## Overview

This document describes how to integrate the Benchmark Anomaly Correcting Agent with the existing AgentX benchmark system and self-healing engine.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Benchmark System                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ Batch Runner │────▶│  Anomaly     │────▶│  Correcting  │    │
│  │ (Service)    │     │  Detector    │     │  Agent (AI)  │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│         │                     │                     │            │
│         ▼                     ▼                     ▼            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Self-Healing Engine                          │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │  │
│  │  │ Rule Eval  │  │ Cooldown   │  │ Remediation Action │ │  │
│  │  │ Engine     │  │ Tracker    │  │ Executor           │ │  │
│  │  └────────────┘  └────────────┘  └────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
│         │                     │                     │            │
│         ▼                     ▼                     ▼            │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  MongoDB     │     │  Alert       │     │  Notification│    │
│  │  (Audit Log) │     │  Service     │     │  Service     │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Steps

### Step 1: Create Anomaly Detection Service

**File:** `/src/services/benchmarkAnomalyDetector.js`

```javascript
const logger = require('../../config/logger');

/**
 * Benchmark Anomaly Detector
 * Analyzes batch execution data to detect performance anomalies
 */
class BenchmarkAnomalyDetector {
  constructor() {
    this.thresholds = {
      exec_fail_pct: 10,
      judge_fail_pct: 5,
      lag_factor: 5,
      avg_near_timeout_pct: 80,
      model_min_n: 5,
      model_exec_out_pct: 20,
      model_judge_out_pct: 10,
      model_tps_below_median_pct: 30,
      model_judge_ms_above_median_pct: 50
    };
  }

  /**
   * Analyze batch for anomalies
   * @param {Object} batch - Batch document from MongoDB
   * @param {Array} results - BenchmarkResult documents
   * @returns {Array} Array of detected anomalies
   */
  detectAnomalies(batch, results) {
    const anomalies = [];
    const models = batch.models || [];

    // Per-model anomaly detection
    for (const model of models) {
      const modelResults = results.filter(r => r.model === model);
      if (modelResults.length < this.thresholds.model_min_n) continue;

      // Execution failure detection
      const execFailures = modelResults.filter(r => !r.success).length;
      const execFailRate = execFailures / modelResults.length;
      if (execFailRate >= this.thresholds.exec_fail_pct / 100) {
        anomalies.push({
          type: 'EXEC_FAIL',
          model,
          severity: this._getSeverity(execFailRate, [0.2, 0.35, 0.5]),
          count: execFailures,
          rate: execFailRate,
          threshold: this.thresholds.exec_fail_pct / 100,
          sample_errors: this._getSampleErrors(modelResults, 3)
        });
      }

      // Throughput anomaly detection
      const tpsValues = modelResults
        .map(r => r.tokens_per_sec)
        .filter(v => Number.isFinite(v) && v > 0);

      if (tpsValues.length >= this.thresholds.model_min_n) {
        const avgTps = tpsValues.reduce((sum, v) => sum + v, 0) / tpsValues.length;
        const medianTps = this._getMedian(tpsValues);
        const allTpsValues = results
          .map(r => r.tokens_per_sec)
          .filter(v => Number.isFinite(v) && v > 0);
        const overallMedianTps = this._getMedian(allTpsValues);

        if (overallMedianTps && avgTps < overallMedianTps * (1 - this.thresholds.model_tps_below_median_pct / 100)) {
          const deviation = (avgTps - overallMedianTps) / overallMedianTps;
          anomalies.push({
            type: 'LOW_TPS',
            model,
            severity: this._getSeverity(Math.abs(deviation), [0.3, 0.5, 0.7]),
            avg_tps: avgTps,
            median_tps: overallMedianTps,
            deviation: (deviation * 100).toFixed(1) + '%',
            threshold: `-${this.thresholds.model_tps_below_median_pct}%`
          });
        }
      }

      // Judge failure detection
      if (batch.quality_scoring) {
        const judgeFailures = modelResults.filter(r =>
          r.scoring_method && r.scoring_method.toLowerCase() === 'llm_failed'
        ).length;
        const judgedTests = modelResults.filter(r => r.scoring_method).length;

        if (judgedTests >= this.thresholds.model_min_n) {
          const judgeFailRate = judgeFailures / judgedTests;
          if (judgeFailRate >= this.thresholds.judge_fail_pct / 100) {
            anomalies.push({
              type: 'JUDGE_FAIL',
              model,
              severity: this._getSeverity(judgeFailRate, [0.1, 0.2, 0.35]),
              count: judgeFailures,
              rate: judgeFailRate,
              threshold: this.thresholds.judge_fail_pct / 100
            });
          }
        }
      }
    }

    // Judge health anomalies
    if (batch.judge_stats) {
      const { lag, avg_time_ms, timeout_ms } = batch.judge_stats;

      if (lag > this.thresholds.lag_factor) {
        anomalies.push({
          type: 'JUDGE_OVERLOAD',
          severity: this._getSeverity(lag, [10, 15, 20]),
          lag,
          threshold: this.thresholds.lag_factor,
          avg_time_ms,
          timeout_ms
        });
      }

      if (avg_time_ms && timeout_ms) {
        const timeoutPct = (avg_time_ms / timeout_ms) * 100;
        if (timeoutPct >= this.thresholds.avg_near_timeout_pct) {
          anomalies.push({
            type: 'JUDGE_SLOW',
            severity: this._getSeverity(timeoutPct, [80, 90, 95]),
            avg_time_ms,
            timeout_ms,
            percent_of_timeout: timeoutPct.toFixed(1) + '%',
            threshold: this.thresholds.avg_near_timeout_pct + '%'
          });
        }
      }
    }

    // Stuck batch detection
    if (batch.status === 'running' || batch.status === 'judging') {
      const inactiveMs = Date.now() - new Date(batch.last_activity_at).getTime();
      if (inactiveMs > 300000) { // 5 minutes
        anomalies.push({
          type: 'BATCH_STUCK',
          severity: 'critical',
          inactive_ms: inactiveMs,
          inactive_seconds: Math.floor(inactiveMs / 1000),
          threshold: 300
        });
      }
    }

    return anomalies;
  }

  _getSeverity(value, thresholds) {
    // thresholds: [medium, high, critical]
    if (value >= thresholds[2]) return 'critical';
    if (value >= thresholds[1]) return 'high';
    if (value >= thresholds[0]) return 'medium';
    return 'low';
  }

  _getMedian(values) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  _getSampleErrors(results, limit = 3) {
    return results
      .filter(r => !r.success && r.error)
      .slice(0, limit)
      .map(r => r.error);
  }
}

module.exports = new BenchmarkAnomalyDetector();
```

---

### Step 2: Create Correcting Agent Service

**File:** `/src/services/benchmarkCorrectingAgent.js`

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../config/logger');
const selfHealingEngine = require('./selfHealingEngine');
const fs = require('fs').promises;
const path = require('path');

/**
 * Benchmark Correcting Agent
 * AI-powered anomaly analysis and remediation
 */
class BenchmarkCorrectingAgent {
  constructor() {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    this.systemPrompt = null;
  }

  /**
   * Load agent prompt from file
   */
  async loadPrompt() {
    if (this.systemPrompt) return;

    const promptPath = path.join(__dirname, '../../docs/agents/BENCHMARK_CORRECTING_AGENT_PROMPT.md');
    this.systemPrompt = await fs.readFile(promptPath, 'utf-8');
    logger.info('Benchmark Correcting Agent prompt loaded');
  }

  /**
   * Analyze anomalies and recommend remediation
   * @param {Object} batch - Batch document
   * @param {Array} anomalies - Detected anomalies
   * @param {Array} results - Benchmark results
   * @param {Object} environment - Environment context
   * @returns {Object} Agent response with remediation plan
   */
  async analyzeAndRemediate(batch, anomalies, results, environment) {
    await this.loadPrompt();

    // Build context for the agent
    const context = this._buildContext(batch, anomalies, results, environment);

    // Call Claude API
    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      temperature: 0.1, // Low temperature for deterministic decisions
      system: this.systemPrompt,
      messages: [
        {
          role: 'user',
          content: JSON.stringify(context, null, 2)
        }
      ]
    });

    const agentOutput = response.content[0].text;

    // Parse agent response (assuming JSON output)
    let remediation;
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = agentOutput.match(/```json\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : agentOutput;
      remediation = JSON.parse(jsonStr);
    } catch (err) {
      logger.error('Failed to parse agent response', { error: err.message });
      throw new Error('Agent response was not valid JSON');
    }

    // Execute remediation if auto-approved
    if (!remediation.recommendation.requires_approval && remediation.execution) {
      const executed = await this._executeRemediation(
        batch,
        remediation.execution,
        remediation.recommendation
      );
      remediation.executed = executed;
    }

    // Log to database
    await this._logRemediation(batch._id, anomalies, remediation);

    return remediation;
  }

  /**
   * Build context object for agent
   */
  _buildContext(batch, anomalies, results, environment) {
    // Calculate per-model metrics
    const perModelMetrics = {};
    const models = batch.models || [];

    for (const model of models) {
      const modelResults = results.filter(r => r.model === model);
      perModelMetrics[model] = this._calculateMetrics(modelResults);
    }

    // Calculate judge stats
    const judgeStats = batch.judge_stats || {
      lag: 0,
      avg_time_ms: null,
      timeout_ms: environment.judge_config?.timeout || 30000,
      failed: 0,
      pending: 0,
      health: 'healthy'
    };

    // Get recent batch history
    const history = {
      recent_batches: [], // TODO: Query from database
      model_baselines: {} // TODO: Query from database
    };

    return {
      batch: {
        id: batch._id.toString(),
        status: batch.status,
        progress: batch.progress,
        total_tests: batch.total_tests,
        completed: batch.completed,
        models: batch.models,
        levels: batch.plan?.levels || [],
        quality_scoring: batch.quality_scoring,
        execution_mode: batch.execution_mode || 'latency',
        created_at: batch.created_at,
        last_activity_at: batch.last_activity_at
      },
      anomalies,
      metrics: {
        per_model: perModelMetrics,
        judge_stats: judgeStats
      },
      environment,
      history
    };
  }

  /**
   * Calculate metrics from results array
   */
  _calculateMetrics(results) {
    if (results.length === 0) {
      return {
        tests: 0,
        latency: { p50: null, p95: null, mean: null },
        throughput: { p50: null, mean: null },
        quality: { p50: null, mean: null },
        exec_failures: 0,
        judge_failures: 0
      };
    }

    const latencies = results.map(r => r.latency_ms).filter(Number.isFinite);
    const tps = results.map(r => r.tokens_per_sec).filter(v => Number.isFinite(v) && v > 0);
    const qualities = results.map(r => r.quality_score).filter(Number.isFinite);

    return {
      tests: results.length,
      latency: this._calcStats(latencies),
      throughput: this._calcStats(tps),
      quality: this._calcStats(qualities),
      exec_failures: results.filter(r => !r.success).length,
      judge_failures: results.filter(r => r.scoring_method === 'llm_failed').length
    };
  }

  _calcStats(values) {
    if (values.length === 0) return { p50: null, p95: null, mean: null };

    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const p50 = this._percentile(sorted, 0.5);
    const p95 = this._percentile(sorted, 0.95);

    return { p50, p95, mean };
  }

  _percentile(sorted, p) {
    const idx = p * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    const weight = idx - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  /**
   * Execute remediation action via self-healing engine
   */
  async _executeRemediation(batch, execution, recommendation) {
    try {
      const remediationRecord = {
        issueType: `benchmark_anomaly_${execution.payload.action}`,
        severity: recommendation.risk_level === 'low' ? 'medium' : 'high',
        context: {
          batch_id: batch._id.toString(),
          ...execution.payload
        },
        strategy: recommendation.strategy,
        action: recommendation.action,
        automatedExecution: true
      };

      // Route to self-healing engine
      await selfHealingEngine.executeRemediation(remediationRecord);

      logger.info('Benchmark remediation executed', {
        batch_id: batch._id,
        action: recommendation.action
      });

      return { success: true, timestamp: new Date() };
    } catch (err) {
      logger.error('Failed to execute remediation', {
        batch_id: batch._id,
        error: err.message
      });
      return { success: false, error: err.message };
    }
  }

  /**
   * Log remediation to database
   */
  async _logRemediation(batchId, anomalies, remediation) {
    const { RemediationAction } = require('../../models/RemediationAction');

    await RemediationAction.create({
      issueType: 'benchmark_anomaly',
      severity: remediation.analysis.severity,
      context: {
        batch_id: batchId.toString(),
        anomalies: anomalies.map(a => ({ type: a.type, severity: a.severity })),
        recommendation: remediation.recommendation
      },
      strategy: remediation.recommendation.strategy,
      action: remediation.recommendation.action,
      automatedExecution: !remediation.recommendation.requires_approval,
      status: remediation.executed?.success ? 'succeeded' : 'pending'
    });
  }
}

module.exports = new BenchmarkCorrectingAgent();
```

---

### Step 3: Add Monitoring Endpoint

**File:** `/routes/benchmark.js` (add these routes)

```javascript
/**
 * GET /api/benchmark/batch/:id/anomalies
 * Detect anomalies in running batch
 */
router.get('/batch/:id/anomalies', async (req, res) => {
  try {
    const batch = await BenchmarkBatch.findById(req.params.id);
    if (!batch) {
      return res.status(404).json({ status: 'error', message: 'Batch not found' });
    }

    const results = await BenchmarkResult.find({ batch_id: batch._id });
    const anomalyDetector = require('../src/services/benchmarkAnomalyDetector');
    const anomalies = anomalyDetector.detectAnomalies(batch, results);

    res.json({
      status: 'success',
      data: {
        batch_id: batch._id,
        anomalies,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error('Failed to detect anomalies', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/benchmark/batch/:id/analyze
 * Run correcting agent analysis
 */
router.post('/batch/:id/analyze', async (req, res) => {
  try {
    const batch = await BenchmarkBatch.findById(req.params.id);
    if (!batch) {
      return res.status(404).json({ status: 'error', message: 'Batch not found' });
    }

    const results = await BenchmarkResult.find({ batch_id: batch._id });

    // Detect anomalies
    const anomalyDetector = require('../src/services/benchmarkAnomalyDetector');
    const anomalies = anomalyDetector.detectAnomalies(batch, results);

    if (anomalies.length === 0) {
      return res.json({
        status: 'success',
        data: { message: 'No anomalies detected', anomalies: [] }
      });
    }

    // Get environment context
    const environment = {
      primary_host: process.env.OLLAMA_HOST,
      secondary_host: process.env.OLLAMA_HOST_SECONDARY,
      judge_config: {
        model: batch.judge_config?.model || 'llama3.3:70b',
        host: batch.judge_config?.host || process.env.OLLAMA_HOST,
        timeout: batch.judge_config?.timeout || 30000,
        concurrency: batch.judge_config?.concurrency || 2
      }
      // TODO: Add VRAM status from /api/ps
    };

    // Run correcting agent
    const correctingAgent = require('../src/services/benchmarkCorrectingAgent');
    const remediation = await correctingAgent.analyzeAndRemediate(
      batch,
      anomalies,
      results,
      environment
    );

    res.json({
      status: 'success',
      data: {
        anomalies,
        remediation,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error('Failed to analyze batch', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/benchmark/batch/:id/remediate
 * Execute remediation action
 */
router.post('/batch/:id/remediate', async (req, res) => {
  try {
    const { action, model, target_host, retry_failed, test_ids } = req.body;
    const batch = await BenchmarkBatch.findById(req.params.id);

    if (!batch) {
      return res.status(404).json({ status: 'error', message: 'Batch not found' });
    }

    // Execute action based on type
    let result;
    switch (action) {
      case 'failover_model':
        result = await benchmarkService.failoverModel(batch, model, target_host);
        if (retry_failed && test_ids) {
          await benchmarkService.retryTests(batch, test_ids);
        }
        break;

      case 'reduce_judge_concurrency':
        result = await benchmarkService.adjustJudgeConcurrency(batch, 1);
        break;

      case 'stop_batch':
        result = await batch.markAsStopped();
        break;

      default:
        return res.status(400).json({
          status: 'error',
          message: `Unknown action: ${action}`
        });
    }

    res.json({
      status: 'success',
      data: { action, result, timestamp: new Date() }
    });
  } catch (error) {
    logger.error('Failed to execute remediation', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});
```

---

### Step 4: Add Scheduled Monitoring

**File:** `/src/jobs/benchmarkMonitor.js`

```javascript
const cron = require('node-cron');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const anomalyDetector = require('../services/benchmarkAnomalyDetector');
const correctingAgent = require('../services/benchmarkCorrectingAgent');
const logger = require('../../config/logger');

/**
 * Monitor active batches every 30 seconds
 */
function startBenchmarkMonitor() {
  cron.schedule('*/30 * * * * *', async () => {
    try {
      // Find running batches
      const activeBatches = await BenchmarkBatch.find({
        status: { $in: ['running', 'judging'] }
      });

      for (const batch of activeBatches) {
        // Get results
        const results = await BenchmarkResult.find({ batch_id: batch._id });

        // Detect anomalies
        const anomalies = anomalyDetector.detectAnomalies(batch, results);

        if (anomalies.length > 0) {
          logger.warn('Anomalies detected in batch', {
            batch_id: batch._id,
            anomaly_count: anomalies.length,
            types: anomalies.map(a => a.type)
          });

          // Only auto-remediate critical/high severity
          const criticalAnomalies = anomalies.filter(a =>
            a.severity === 'critical' || a.severity === 'high'
          );

          if (criticalAnomalies.length > 0) {
            logger.info('Running correcting agent', {
              batch_id: batch._id,
              critical_count: criticalAnomalies.length
            });

            const environment = {
              primary_host: process.env.OLLAMA_HOST,
              secondary_host: process.env.OLLAMA_HOST_SECONDARY,
              judge_config: batch.judge_config || {}
            };

            await correctingAgent.analyzeAndRemediate(
              batch,
              criticalAnomalies,
              results,
              environment
            );
          }
        }
      }
    } catch (error) {
      logger.error('Benchmark monitor error', { error: error.message });
    }
  });

  logger.info('Benchmark monitor started (30s interval)');
}

module.exports = { startBenchmarkMonitor };
```

---

### Step 5: Initialize in Server

**File:** `/server.js` (add these lines)

```javascript
const { startBenchmarkMonitor } = require('./src/jobs/benchmarkMonitor');

// ... existing code ...

// Start benchmark monitoring
if (process.env.ENABLE_BENCHMARK_MONITOR !== 'false') {
  startBenchmarkMonitor();
}
```

---

## Environment Variables

Add to `.env`:

```bash
# Benchmark Correcting Agent
ENABLE_BENCHMARK_MONITOR=true
ANTHROPIC_API_KEY=sk-ant-...

# Self-Healing Settings
SELF_HEALING_ENABLED=true
REQUIRE_APPROVAL=false  # Set to true for production
MAX_CONCURRENT_ACTIONS=3
```

---

## Testing

### Manual Test

```bash
# Start a batch
curl -X POST http://localhost:3080/api/benchmark/batch \
  -H "Content-Type: application/json" \
  -d '{
    "host": "http://192.168.1.100:11434",
    "models": ["llama2", "mistral"],
    "levels": [1, 2],
    "quality_scoring": true
  }'

# Check for anomalies
curl http://localhost:3080/api/benchmark/batch/{batch_id}/anomalies

# Run correcting agent
curl -X POST http://localhost:3080/api/benchmark/batch/{batch_id}/analyze
```

### Automated Test

```javascript
// tests/services/benchmarkCorrectingAgent.test.js
const correctingAgent = require('../../src/services/benchmarkCorrectingAgent');

test('should detect and remediate VRAM exhaustion', async () => {
  const batch = { /* mock batch */ };
  const anomalies = [
    { type: 'EXEC_FAIL', severity: 'high', model: 'codellama' }
  ];
  const results = [/* mock results */];
  const environment = {
    primary_host: 'http://192.168.1.100:11434',
    secondary_host: 'http://192.168.1.101:11434'
  };

  const remediation = await correctingAgent.analyzeAndRemediate(
    batch, anomalies, results, environment
  );

  expect(remediation.recommendation.strategy).toBe('model_failover');
  expect(remediation.recommendation.requires_approval).toBe(false);
});
```

---

## Dashboard Integration

Add to [benchmark.html](benchmark.html):

```html
<!-- Anomaly Alert Section -->
<div id="anomalyAlerts" style="display: none;">
  <div class="alert alert-warning">
    <h4>⚠️ Anomalies Detected</h4>
    <div id="anomalyList"></div>
    <button onclick="runCorrectingAgent()">🤖 Analyze & Fix</button>
  </div>
</div>

<script>
async function checkAnomalies(batchId) {
  const res = await fetch(`/api/benchmark/batch/${batchId}/anomalies`);
  const { data } = await res.json();

  if (data.anomalies.length > 0) {
    document.getElementById('anomalyAlerts').style.display = 'block';
    document.getElementById('anomalyList').innerHTML = data.anomalies
      .map(a => `<div class="anomaly-item">
        <span class="badge badge-${a.severity}">${a.severity}</span>
        <strong>${a.type}</strong>: ${a.model || 'All models'}
      </div>`)
      .join('');
  }
}

async function runCorrectingAgent() {
  const res = await fetch(`/api/benchmark/batch/${currentBatchId}/analyze`, {
    method: 'POST'
  });
  const { data } = await res.json();

  // Display remediation plan
  console.log('Remediation:', data.remediation);
  alert('Correcting agent analysis complete. Check console for details.');
}

// Poll for anomalies every 30s
setInterval(() => {
  if (currentBatchId) checkAnomalies(currentBatchId);
}, 30000);
</script>
```

---

## Monitoring & Logging

All remediation actions are logged to:

1. **MongoDB** - `RemediationAction` collection
2. **Application Logs** - `/logs/agentx.log`
3. **Timeline Events** - Batch `timeline` array

Example query:

```javascript
// Get all remediation actions for a batch
const actions = await RemediationAction.find({
  'context.batch_id': batchId
}).sort({ createdAt: -1 });
```

---

## Future Enhancements

1. **Real-Time WebSocket Notifications**
   - Push anomaly alerts to connected clients
   - Live remediation progress updates

2. **Approval Workflow UI**
   - Modal dialog for high-risk actions
   - Show impact analysis before approval

3. **Machine Learning Baselines**
   - Train model on historical benchmark data
   - Detect subtle performance regressions

4. **Auto-Tuning**
   - Agent learns optimal thresholds over time
   - Adjusts based on remediation success rates

5. **Multi-Batch Coordination**
   - Detect cross-batch patterns
   - Recommend system-wide fixes

---

## Support

For questions or issues, see:
- [BENCHMARK_CORRECTING_AGENT_PROMPT.md](BENCHMARK_CORRECTING_AGENT_PROMPT.md) - Agent system prompt
- [ROADMAP.md](../../ROADMAP.md) - Track 4: Self-Healing
- [Self-Healing Quick Start](../SELF_HEALING_QUICK_START.md) - Self-healing engine guide
