# n8n LLM Webhook Contract

## Overview
This document specifies the contract between AgentX and the n8n LLM Gateway workflows. AgentX sends a unified request format, and the n8n workflow parses this, calls the specific provider, and formats the response back to a unified response format.

## Request Format

**Endpoint**: `POST /webhook/llm-gateway-{provider}`

**Headers**:
- `Content-Type: application/json`

**Body**:
```json
{
  "prompt": "User message or system+user combined text",
  "max_tokens": 1000,
  "temperature": 0.7,
  "top_p": 0.9
}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `prompt` | string | Yes | The input text for the LLM. |
| `max_tokens` | number | No | Maximum tokens to generate (default: 1000). |
| `temperature` | number | No | Sampling temperature (0-1) (default: 0.7). |
| `top_p` | number | No | Nucleus sampling parameter (default: 0.9). |


## Response Format

**Status Code**: `200 OK`

**Body**:
```json
{
  "completion": "The AI's response text...",
  "usage": {
    "promptTokens": 123,
    "completionTokens": 456,
    "totalTokens": 579
  },
  "model": "gpt-4-turbo"
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `completion` | string | The generated text from the model. |
| `usage.promptTokens` | number | Number of tokens in the prompt. |
| `usage.completionTokens` | number | Number of tokens in the completion. |
| `usage.totalTokens` | number | Total tokens used. |
| `model` | string | The specific model name used (e.g., `gpt-4-turbo`, `claude-3-opus`, `gemini-pro`). |


## Error Format

**Status Code**: `4xx` or `5xx`

**Body**:
```json
{
  "error": "Detailed error message",
  "statusCode": 500
}
```
