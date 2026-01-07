# n8n LLM Gateway Setup

## Purpose
Use cloud LLMs (OpenAI, Anthropic, Google) in AgentX without storing API keys in AgentX.

## Prerequisites
- n8n instance running
- API key for cloud provider (OpenAI, Anthropic, or Google)

## Step 1: Import Workflow
1. Open n8n
2. Import the desired workflow JSON:
   - `N6.0-LLM-Gateway-OpenAI.json` (for GPT-4)
   - `N6.1-LLM-Gateway-Anthropic.json` (for Claude)
   - `N6.2-LLM-Gateway-Google.json` (for Gemini)
3. Configure the Credentials in the AI node (OpenAI, Anthropic, or Google Gemini).
4. Activate the workflow.

## Step 2: Get Webhook URL
1. Click the "Webhook Trigger" node.
2. Ensure you are using the "Production" URL for stable usage.
3. Copy the URL.
   - Example: `https://n8n.your-domain.com/webhook/llm-gateway-openai`
   - Example: `https://n8n.your-domain.com/webhook/llm-gateway-anthropic`
   - Example: `https://n8n.your-domain.com/webhook/llm-gateway-google`

## Step 3: Register in AgentX
1. Open `models.html` in AgentX.
2. Click "Add Source" → "Add n8n Webhook LLM".
3. Fill the form based on the provider:

   ### OpenAI
   - **Name**: "GPT-4 Turbo via n8n"
   - **Provider**: `openai`
   - **Webhook URL**: [paste from Step 2]
   - **Request template**:
     ```json
     {
       "prompt": "{{prompt}}",
       "max_tokens": {{maxTokens}},
       "temperature": {{temperature}}
     }
     ```
   - **Response path**: `completion`

   ### Anthropic
   - **Name**: "Claude 3 via n8n"
   - **Provider**: `anthropic`
   - **Webhook URL**: [paste from Step 2]
   - **Request template**:
     ```json
     {
       "prompt": "{{prompt}}",
       "max_tokens": {{maxTokens}},
       "temperature": {{temperature}}
     }
     ```
   - **Response path**: `completion`

   ### Google
   - **Name**: "Gemini Pro via n8n"
   - **Provider**: `google`
   - **Webhook URL**: [paste from Step 2]
   - **Request template**:
     ```json
     {
       "prompt": "{{prompt}}",
       "max_tokens": {{maxTokens}},
       "temperature": {{temperature}}
     }
     ```
   - **Response path**: `completion`

4. Click "Test Connection" (should return sample response).
5. Click "Save".

## Step 4: Use in Chat
1. Open chat interface (`index.html`).
2. Select the registered model (e.g., "GPT-4 Turbo via n8n") from the model dropdown.
3. Chat normally. AgentX routes the request to n8n, which calls the cloud LLM and returns the completion.

## Testing with CURL

You can test the webhook directly to ensure n8n is working before connecting AgentX.

```bash
# Test OpenAI Gateway
curl -X POST https://n8n.your-domain.com/webhook/llm-gateway-openai \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "What is 2+2?",
    "max_tokens": 100,
    "temperature": 0.7
  }'
```

## Troubleshooting
- **"Connection failed"**: Check if the n8n workflow is set to "Active".
- **"API key invalid"**: Open n8n, check the credentials in the AI node (OpenAI/Anthropic/Google).
- **"Rate limit exceeded"**: The cloud provider quota has been reached. Check your billing/credits.
- **"404 Not Found"**: Verify the Webhook URL path matches the one defined in the "Webhook Trigger" node.
