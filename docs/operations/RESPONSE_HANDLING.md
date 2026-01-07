# Response Handling

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Response Handling

> **Context:** How AgentX processes and formats LLM responses, including thinking model support and template cleaning.

## Overview

**Helper Service:** `/src/helpers/ollamaResponseHandler.js`

This module handles all response processing from Ollama, including special handling for thinking models and template tag cleaning.

---

## Thinking Model Support

**Thinking Models:** qwen, deepseek-r1, reasoning models

These models output separate fields:
- `thinking` field - Internal reasoning process (not shown to users)
- `content` field - User-facing response

**Critical Fields:**
```javascript
data.message.content   // Standard response
data.message.thinking  // Reasoning process (thinking models only)
data.response          // Legacy format (generate API)
```

**Usage Pattern:**
```javascript
const { content, thinking } = parseOllamaResponse(data);
// Store thinking for debugging, return content to user
```

---

## Template Tag Cleaning

Some models leak template tags like `<|start_header_id|>`.

**Solution:** Regex-based cleaning in `cleanContent()` removes:
- `<|start_header_id|>...<|end_header_id|>`
- `<|eot_id|>`
- `<|begin_of_text|>`
- Other model-specific artifacts

**Implementation:**
```javascript
function cleanContent(content) {
  return content
    .replace(/<\|start_header_id\|>.*?<\|end_header_id\|>/gs, '')
    .replace(/<\|eot_id\|>/g, '')
    .replace(/<\|begin_of_text\|>/g, '')
    .trim();
}
```

---

## Stats Collection (V4 Analytics)

When `data.done=true`, performance stats are collected:

```javascript
stats = {
  usage: { 
    promptTokens,      // Input tokens
    completionTokens,  // Output tokens
    totalTokens        // Combined
  },
  performance: { 
    totalDuration,     // End-to-end time
    evalDuration,      // Model inference time
    tokensPerSecond    // Throughput metric
  }
}
// Stored in message.stats for analytics
```

**Usage:** These stats power the V4 analytics dashboard and benchmark comparisons.

---

## Related Documentation

- [Model Routing](../architecture/MODEL_ROUTING.md) - How models are selected
- [Critical Conventions](../patterns/CRITICAL_CONVENTIONS.md) - Error handling patterns
- [Benchmark System](BENCHMARK_SYSTEM.md) - Quality scoring using stats

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
