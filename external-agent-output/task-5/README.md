# Task Package 5: n8n LLM Gateway Templates

This package contains n8n workflow templates to expose cloud LLMs (OpenAI, Anthropic, Google) as webhook endpoints for AgentX. This allows using these models within AgentX without storing API keys in the AgentX codebase or database.

## Deliverables

### Workflow Templates
- **[N6.0-LLM-Gateway-OpenAI.json](./N6.0-LLM-Gateway-OpenAI.json)**: Workflow for OpenAI (GPT-4 etc.)
- **[N6.1-LLM-Gateway-Anthropic.json](./N6.1-LLM-Gateway-Anthropic.json)**: Workflow for Anthropic (Claude 3 etc.)
- **[N6.2-LLM-Gateway-Google.json](./N6.2-LLM-Gateway-Google.json)**: Workflow for Google (Gemini Pro)

### Documentation
- **[Setup Guide](./docs/n8n-llm-gateway.md)**: Step-by-step instructions for importing workflows and registering them in AgentX.
- **[Contract Specification](./docs/contract-spec.md)**: Technical details on the JSON request/response format expected by the workflows.

## Integration Steps

1. **Import Workflows**: Import the JSON files into your n8n instance.
2. **Configure Credentials**: Add your API keys (OpenAI / Anthropic / Google) in the respective n8n nodes.
3. **Register in AgentX**: Use the `models.html` page to add a new "n8n Webhook LLM" source, pointing to your n8n webhook URL.
4. **Test**: Verify connection and start chatting.

## Testing

You can verify the workflows independently of AgentX using `curl`:

```bash
curl -X POST <YOUR_N8N_WEBHOOK_URL> \
     -H "Content-Type: application/json" \
     -d '{"prompt": "Hello world", "max_tokens": 50}'
```
