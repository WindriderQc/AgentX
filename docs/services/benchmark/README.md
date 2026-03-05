# Benchmark & Quality Service

**Agent:** BenchmarkAgent
**Status:** Active

## Responsibility
LLM benchmarking, quality scoring, judging (decomposed judge, conversation judge, judge validation, judge confidence), result analytics, leaderboard, batch management, generalist scoring, prompt sampling, error classification.

## File Inventory

### Services — Benchmark Core (src/services/benchmark/)
| File | Lines | Purpose |
|------|-------|---------|
| index.js | 171 | Facade/entry point |
| execution.js | 672 | Test execution orchestration |
| results.js | 742 | Result aggregation and analysis |
| batches.js | 489 | Batch creation and management |
| judging.js | 437 | Judge execution and response evaluation |
| judges.js | 305 | Judge model definitions |
| generalistScore.js | 352 | Generalist model scoring |
| init.js | 284 | Benchmark initialization |
| config.js | 110 | Benchmark configuration |
| ConcurrencyQueue.js | 162 | Concurrency control for test execution |
| batchPlanner.js | 96 | Batch planning and scheduling |
| categoryParity.js | 86 | Category-balanced test distribution |
| promptSampling.js | 96 | Balanced prompt sampling |
| testExecution.js | 108 | Individual test execution |
| modelWarmup.js | 130 | Model preloading before benchmarks |
| judgeModelValidator.js | 136 | Judge capability validation |
| errorClassifier.js | 67 | Error classification for tests |

### Services — Scoring Engines (src/services/scoring/)
| File | Lines | Purpose |
|------|-------|---------|
| scoringConfigs.js | 462 | Scoring configuration templates |
| judgeCall.js | 242 | Call judges and parse responses |
| formatComplianceScorer.js | 158 | Format compliance checking |
| compositeScorer.js | 103 | Composite score blending |
| complianceScorer.js | 97 | Compliance scoring |
| jsonUtils.js | 82 | JSON parsing utilities |
| quickScorer.js | 75 | Fast scoring heuristics |

### Services — Quality & Judging (src/services/)
| File | Lines | Purpose |
|------|-------|---------|
| qualityScorer.js | 692 | Quality score calculation and normalization |
| deterministicScorer.js | 452 | Deterministic quality scoring |
| decomposedJudge.js | 667 | Multi-step reasoning judge |
| referenceScorer.js | 357 | Reference-based answer scoring |
| judgeConfidence.js | 303 | Judge confidence scoring |
| judgeValidation.js | 865 | Judge model validation |
| conversationJudge.js | 390 | Benchmark judging for conversations |

### Routes (routes/benchmark/)
| File | Purpose |
|------|---------|
| index.js | Route mounting |
| core.js | Benchmark execution endpoints |
| results.js | Result query endpoints |
| batches.js | Batch management |
| analytics.js | Benchmark analytics |
| diagnostics.js | Diagnostic tools |
| hardware.js | Hardware context |

### Models (models/)
| File | Lines | Purpose |
|------|-------|---------|
| BenchmarkBatch.js | 650 | Batch metadata and results |
| BenchmarkResult.js | 505 | Individual test results |
| BenchmarkPrompt.js | 203 | Test prompt library |
| JudgeGroundTruth.js | 233 | Judge answer keys |

### Frontend
- benchmark/* modules, courthouse-analytics.js (59K), leaderboard.js (57K), results-explorer.js (92K)

## APIs Exposed
- `POST /api/benchmark/run` — Execute benchmark batch
- `GET /api/benchmark/results` — Query results
- `GET /api/benchmark/summary` — Summary statistics
- `GET /api/benchmark/compare` — Model comparison
- `POST /api/benchmark/judge/:id` — Judge a result
- `GET /api/benchmark/batches` — List batches
- `GET /api/benchmark/diagnostics/*` — Diagnostic endpoints

## Dependencies (Consumed)
| Service | Interface | What |
|---------|-----------|------|
| Model Management | `modelRouter.routeRequest()` | Send prompts to models under test |
| Model Management | `modelRouter.HOSTS` | Available host list |
| Model Management | `hardwareProfileService` | GPU/VRAM context |

## Data Ownership
Exclusive write: BenchmarkBatch, BenchmarkResult, BenchmarkPrompt, JudgeGroundTruth.

## Key Patterns
- ConcurrencyQueue for parallel test execution
- Category parity ensures balanced test distribution
- Model warmup before benchmark runs
- benchmark/index.js is the facade pattern (other services should follow this)
