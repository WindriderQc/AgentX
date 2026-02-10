# Critical Conventions

> **Navigation:** [CLAUDE.md](../../CLAUDE.md) → [Documentation Index](../INDEX.md) → Critical Conventions

> **Context:** Mandatory coding patterns and conventions for AgentX development. These are enforced in code reviews.

## Table of Contents

1. [Error Handling Pattern](#error-handling-pattern)
2. [Logging with Winston](#logging-with-winston)
3. [Environment Variables](#environment-variables)

---

## Error Handling Pattern

```javascript
try {
  await operation();
  res.json({ status: 'success', data: {...} });
} catch (err) {
  logger.error('Operation failed', { error: err.message, context: {...} });
  res.status(500).json({ status: 'error', message: err.message });
}
```

**Rules:**
- ALWAYS log errors with context
- NEVER expose stack traces to client (except dev mode)
- Include relevant identifiers (userId, workspaceId, requestId)
- Use appropriate HTTP status codes

**Response Format:**
```javascript
// Success
{ status: 'success', data: {...} }

// Error
{ status: 'error', message: 'Human-readable error' }
```

---

## Logging with Winston

**Logger:** `/config/logger.js`

### Log Levels

| Level | Use Case |
|-------|----------|
| `error` | Failures requiring immediate attention |
| `warn` | Degraded behavior, fallbacks |
| `info` | Significant events (startup, connections, completions) |
| `debug` | Detailed traces (classification, routing, performance) |

### Logging Pattern

```javascript
logger.info('Operation completed', {
  context: 'value',
  metric: 123
});

logger.error('Database connection failed', {
  error: err.message,
  host: process.env.MONGODB_URI,
  retryCount: 3
});
```

### Best Practices

- Always include structured metadata (not string concatenation)
- Use consistent field names across the codebase
- Include timing metrics for performance-critical operations
- Avoid logging sensitive data (tokens, passwords, PII)

---

## Environment Variables

### Critical Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `MONGODB_URI` | Database connection string | Yes |
| `OLLAMA_HOST` | Primary Ollama instance URL | Yes |
| `OLLAMA_HOST_SECONDARY` | Secondary Ollama for heavy models | No |
| `VECTOR_STORE_TYPE` | Switch between 'memory' and 'qdrant' | No (default: memory) |
| `EMBEDDING_MODEL` | Model for generating embeddings | No (default: nomic-embed-text) |
| `AGENTX_API_KEY` | API key for automation/n8n access | For automation |
| `DATAAPI_BASE_URL` | DataAPI proxy base URL | For DataAPI |
| `DATAAPI_API_KEY` | DataAPI authentication key | For DataAPI |
| `PORT` | HTTP server port | No (default: 3080) |

### Access Pattern

```javascript
const value = process.env.VAR_NAME || 'fallback';
```

### Validation

All required variables should be validated at startup:
```javascript
if (!process.env.MONGODB_URI) {
  throw new Error('MONGODB_URI environment variable is required');
}
```

See [Deployment Guide](../architecture/SBQC-Stack-Final/05-DEPLOYMENT.md) for complete environment configuration.

---

## Related Documentation

- [Response Handling](../operations/RESPONSE_HANDLING.md) - Response formatting patterns
- [Testing Patterns](TESTING_PATTERNS.md) - Testing conventions
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - Development workflow
- [Deployment Guide](../architecture/SBQC-Stack-Final/05-DEPLOYMENT.md) - Environment setup

---

**Back to:** [CLAUDE.md](../../CLAUDE.md) | [Documentation Index](../INDEX.md)
