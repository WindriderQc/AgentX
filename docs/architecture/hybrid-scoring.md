# Hybrid Scoring: Deterministic Accuracy + LLM Compliance

## Concept

When `judge_criteria` exist on a prompt, criteria-based scoring returns a **deterministic accuracy score** via regex pattern matching. This checks "did the response contain the right answers?" but NOT "was the response concise, properly formatted, and following instructions?"

Hybrid scoring adds a lightweight **LLM compliance check** (3 binary YES/NO questions) and blends both scores with category-specific weights.

```
quality_score = accuracy_score * accuracy_weight + compliance_score * compliance_weight
```

## Flow

```
criteriaBasedScore(response, prompt)
    ↓ (deterministic accuracy: 0-10)
scoreCompliance(response, prompt, judgeConfig)
    ↓ (LLM binary questions: 0-10)
blendHybridScore(criteriaResult, complianceResult, category)
    ↓ (weighted blend: 0-10)
quality_score with scoring_method='hybrid'
```

If the compliance LLM call fails, the system falls back to pure deterministic scoring.

## Compliance Questions

Three universal binary YES/NO questions evaluated by the judge model:

| # | Question | Weight |
|---|---|---|
| 1 | Does the response avoid unnecessary extra text beyond what was asked for? | 0.40 |
| 2 | Does the response follow the formatting and structural instructions in the task? | 0.35 |
| 3 | Does the response directly address the question without hedging or meta-commentary? | 0.25 |

These evaluate **behavioral conformance** (form), not content accuracy. They are distinct from the `DECOMPOSED_QUESTIONS` used for full LLM judging. Binary YES/NO questions are trivially reliable for 7B models.

## Per-Category Weights

| Category | Accuracy | Compliance | Rationale |
|---|---|---|---|
| context-retention | 0.75 | 0.25 | Content recall is primary |
| instruction-following | 0.55 | 0.45 | Format/compliance matters a lot |
| summarization | 0.60 | 0.40 | Conciseness is part of task quality |
| translation | 0.70 | 0.30 | Accuracy of meaning dominates |
| multi-turn-reasoning | 0.75 | 0.25 | Correctness is primary |
| edge-cases | 0.70 | 0.30 | Handling edge case correctly matters most |
| *(default)* | 0.70 | 0.30 | Safe default for unconfigured categories |

## Example

Prompt: "Give only the answer to 5 + 2"
Response: "The answer is 7, because 5 plus 2 equals 7."

- Accuracy (deterministic): **10/10** (contains "7")
- Compliance (LLM judge): **~5/10** (extra text when asked for "only the answer")
- Blended (context-retention weights): `10*0.75 + 5*0.25 = 8.75`

## Files

| File | Role |
|---|---|
| `src/services/scoring/complianceScorer.js` | COMPLIANCE_QUESTIONS, scoreCompliance(), blendHybridScore() |
| `src/services/scoring/scoringConfigs.js` | hybrid_compliance + hybrid_weights in CATEGORY_STRATEGIES |
| `src/services/qualityScorer.js` | Phase 1.5 routing: criteria → compliance → blend |
| `models/BenchmarkResult.js` | accuracy_score, compliance_score fields; 'hybrid' enum |
| `src/services/benchmark/judging.js` | Persists accuracy_score + compliance_score |
| `public/js/benchmark/judge-details.js` | Renders accuracy/compliance sub-scores in UI |
