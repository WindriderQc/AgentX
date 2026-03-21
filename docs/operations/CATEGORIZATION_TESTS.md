# Model Categorization Test Suite

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Categorization Tests

> **Context:** Diagnostic categorization should now resolve models into the same 7 canonical benchmark categories used across the benchmark system.

## Canonical Categories

Any categorization workflow should map results to exactly these keys:

- `coding`
- `reasoning`
- `math`
- `knowledge`
- `instruction`
- `creative`
- `translation`

## Mapping Rules

Legacy labels should be treated as conceptual inputs only, not persisted benchmark categories:

| Legacy label | Canonical category |
|--------------|--------------------|
| `factual`, `general`, `explanation`, `context-retention` | `knowledge` |
| `instruction-following`, `summarization` | `instruction` |
| `multi-turn-reasoning`, `edge-cases` | `reasoning` |
| `refactoring`, `debugging`, `code` | `coding` |
| `dialogue` | `creative` |

## Authoring Guidance

- Keep diagnostic prompts aligned to the consolidated 5-level benchmark scale.
- Prefer levels 2-4 for differentiating models without excessive floor/ceiling effects.
- Persist benchmark-facing output using canonical category keys only.
- When a prompt spans multiple older concepts, choose the consolidated category that best matches the primary evaluation objective.

## Recommended Validation

- Confirm diagnostic output categories are a subset of the 7 canonical keys.
- Confirm prompt levels stay within `1..5`.
- Confirm any benchmark sync or leaderboard integration uses canonical keys from `config/categories.js`.

## Related Documentation

- [BENCHMARK_SYSTEM.md](./BENCHMARK_SYSTEM.md)
- [Model Registry](../architecture/MODEL_REGISTRY.md)
