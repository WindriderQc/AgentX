# External Agent Task Packages

**Purpose**: Optimize Claude Code workload by delegating isolated, well-defined tasks to external agents.

**What Claude Code Keeps**:
- Integration work (wiring components together)
- Plan synchronization (ROADMAP.md, CLAUDE.md updates)
- System coordination (chatService, routing, n8n contracts)
- Phase 0 validation (requires coordinated multi-system checks)

**What External Agents Handle**:
- UX design (wireframes, component specs)
- Database schema details (with validation rules)
- Algorithm implementation (isolated logic)
- Test suite scaffolding
- Documentation writing (specific guides)

---

## Task Package 1: models.html UX Design Specification

### Input Context
- Target: Unified model catalog showing Ollama models + n8n webhook LLMs + custom models + registry metadata
- Users: Solo developer managing local LLMs across 2 Ollama hosts + cloud LLMs via n8n webhooks
- Current problem: models.html shows "No models found" (only queries CustomModel DB, not live Ollama)
- Required features: Compare 2-4 models side-by-side, filter by category/tag/provider, register n8n webhooks

### Task
Design complete UX specification for models.html redesign with "extensive UI UX guidance".

### Deliverables
1. **Detailed Wireframes** (ASCII art or Figma/Excalidraw):
   - Desktop view (1920x1080)
   - Tablet view (768px)
   - Mobile view (375px)
   - All 4 sections: Sources header, Filters toolbar, Model cards grid, Comparison drawer

2. **Component Hierarchy**:
   ```
   ModelsPage
   ├── SourcesHeader (stats, "Add Source" button)
   ├── FilterBar (search, provider, category, tag, sort, view mode)
   ├── ModelGrid (responsive cards)
   │   └── ModelCard (provider icon, stats, actions)
   ├── ComparisonDrawer (expandable, 2-4 models side-by-side)
   └── Modals
       ├── AddSourceModal (tabs: Ollama, n8n Webhook, Custom)
       ├── ModelDetailModal (full stats, benchmarks, history)
       └── DeployModal (select host, show logs)
   ```

3. **User Flows** (step-by-step with screenshots):
   - Flow 1: Discovery → Filter → Compare → Select for chat
   - Flow 2: Register n8n webhook LLM → Test → Use in chat
   - Flow 3: Create custom model → Deploy to Ollama → Benchmark

4. **Interaction Patterns**:
   - Click model card → Detail modal
   - "Add to Comparison" → Drawer expands with model
   - Filter changes → Instant grid update (no page reload)
   - Sort changes → Animated reorder

5. **Visual Design System**:
   - Color palette (primary, secondary, accent, status colors)
   - Typography scale (headings, body, code, labels)
   - Spacing system (4px grid)
   - Icon set (provider icons, status badges, action buttons)
   - Card design (shadow, border-radius, hover states)

6. **Responsive Breakpoints**:
   - Desktop: 3-column grid
   - Tablet: 2-column grid
   - Mobile: 1-column grid (stacked filters)

7. **Accessibility Considerations**:
   - Keyboard navigation (Tab, Enter, Escape)
   - Screen reader labels (ARIA attributes)
   - Color contrast (WCAG AA minimum)
   - Focus indicators

8. **Empty States & Error Handling**:
   - "No models found" (with "Add Source" CTA)
   - "Ollama host unreachable" (with retry button)
   - "n8n webhook failed test" (with error message)

### Output Format
Markdown document with embedded ASCII wireframes + Excalidraw/Figma link if available.

### Success Criteria
- Claude Code can implement directly from spec (no ambiguity)
- All user flows covered (discovery, selection, registration, deployment)
- Responsive design specified for 3 breakpoints
- Accessibility requirements clear

---

## Task Package 2: Feature Inventory Scanning Algorithm

### Input Context
- Goal: Scan AgentX codebase to detect features and cross-reference frontend/backend/docs
- Codebase structure:
  - Frontend: `public/*.html`, `public/js/*.js`
  - Backend: `routes/*.js`, `src/services/*.js`, `models/*.js`
  - Docs: `docs/**/*.md`, `CLAUDE.md`, `ROADMAP.md`
- Need to match features across sources (e.g., "Cost Tracking" in analytics.html + costCalculator.js + COST_TRACKING_*.md)

### Task
Implement feature scanning and alignment algorithm in JavaScript.

### Deliverables
1. **Feature Detection Patterns**:
   ```javascript
   const FEATURE_PATTERNS = {
     frontend: [
       { pattern: /<!-- (.*?) -->/g, type: 'section-comment' },
       { pattern: /<h[12].*?>(.*?)<\/h[12]>/g, type: 'heading' },
       { pattern: /data-feature="(.*?)"/g, type: 'explicit-tag' }
     ],
     backend: [
       { pattern: /router\.(get|post|put|delete)\('\/api\/(.*?)',/g, type: 'endpoint' },
       { pattern: /class (\w+Service)/g, type: 'service-class' },
       { pattern: /const (\w+Schema) = new mongoose\.Schema/g, type: 'model-schema' }
     ],
     docs: [
       { pattern: /^##+ (.*?)$/gm, type: 'doc-heading' },
       { pattern: /\*\*(.*?)\*\*/g, type: 'emphasized-term' }
     ]
   };
   ```

2. **Feature Matching Algorithm**:
   ```javascript
   function matchFeatures(frontendFeatures, backendFeatures, docFeatures) {
     // Fuzzy matching with Levenshtein distance
     // Return: { complete: [...], partial: [...], missing: [...] }
   }
   ```

3. **Alignment Scoring**:
   ```javascript
   function scoreAlignment(feature) {
     // Returns: { score: 0-100, status: 'complete'|'partial'|'missing', evidence: {...} }
     // Complete: frontend + backend + docs all present
     // Partial: 1-2 of 3 present
     // Missing: 0 present (zombie or planned)
   }
   ```

4. **False Positive Handling**:
   - How to distinguish "Alert" feature vs "alert()" function call
   - How to handle "test" in test files vs actual features
   - How to avoid matching generic terms (API, Model, Service)

5. **Implementation** (`src/services/featureInventoryService.js`):
   ```javascript
   async function scanFrontend() {
     // Reads public/*.html files
     // Extracts feature indicators
     // Returns: { features: [...], pages: [...] }
   }

   async function scanBackend() {
     // Reads routes/*.js, services/*.js, models/*.js
     // Extracts endpoints, services, models
     // Returns: { endpoints: [...], services: [...], models: [...] }
   }

   async function scanDocumentation() {
     // Reads docs/**/*.md
     // Extracts headings, feature descriptions
     // Returns: { features: [...], files: [...] }
   }

   async function generateAlignmentReport() {
     // Calls all scan functions
     // Matches features across sources
     // Returns: { complete: [...], partial: [...], missing: [...], orphaned: [...] }
   }
   ```

6. **Test Cases**:
   ```javascript
   // Test 1: Perfect match
   // Frontend: analytics.html has "Cost Tracking" section
   // Backend: costCalculator.js exists
   // Docs: COST_TRACKING_*.md exists
   // Expected: { status: 'complete', score: 100 }

   // Test 2: Partial match
   // Frontend: voice button exists
   // Backend: routes/voice.js exists
   // Docs: No docs
   // Expected: { status: 'partial', score: 66 }

   // Test 3: Orphaned
   // Frontend: None
   // Backend: routes/janitor.js exists
   // Docs: None
   // Expected: { status: 'orphaned', recommendation: 'Add UI or mark headless' }
   ```

7. **Output Schema**:
   ```javascript
   {
     name: 'Cost Tracking',
     category: 'analytics',
     status: 'complete',
     score: 100,
     evidence: {
       frontend: { files: ['public/analytics.html'], lines: [103, 202, 222, 279] },
       backend: { files: ['src/services/costCalculator.js', 'routes/analytics.js'], endpoints: ['/api/analytics/costs'] },
       docs: { files: ['docs/COST_TRACKING_*.md'], sections: 9 }
     }
   }
   ```

### Output Format
JavaScript implementation file + test suite + documentation of algorithm logic.

### Success Criteria
- Scans 18 HTML files, 23 route files, 50+ docs in < 10 seconds
- < 10% false positives (validated against manual audit)
- Handles edge cases (test files, generic terms, comments)
- Produces actionable alignment report

---

## Task Package 3: chatService.js Test Suite Scaffold

### Input Context
- File: `/home/yb/codes/AgentX/src/services/chatService.js` (411 lines)
- Dependencies: Ollama API, ragStore, costCalculator, toolService, modelRouter
- Critical paths: Routing, RAG integration, cost calculation, error handling, tool execution
- Current coverage: 0% (no dedicated tests exist)
- Target: 80% line coverage minimum

### Task
Create comprehensive test suite scaffold with mocked dependencies.

### Deliverables
1. **Test File Structure** (`tests/unit/chatService.test.js`):
   ```javascript
   describe('chatService', () => {
     describe('sendChatRequest', () => {
       describe('routing logic', () => {
         it('should route to primary host for quick_chat intent');
         it('should route to secondary host for code_generation intent');
         it('should fallback to primary if secondary fails');
       });

       describe('RAG integration', () => {
         it('should append RAG context to system prompt when useRag=true');
         it('should skip RAG when useRag=false');
         it('should handle RAG store unavailable gracefully');
       });

       describe('cost calculation', () => {
         it('should calculate cost when token stats available');
         it('should store cost in message.cost field');
         it('should update conversation.totalCost');
         it('should handle missing pricing config (default to 0)');
       });

       describe('error handling', () => {
         it('should retry on Ollama timeout (3 retries max)');
         it('should return error response when Ollama down');
         it('should handle malformed Ollama response');
         it('should log errors with context');
       });

       describe('tool execution', () => {
         it('should detect /dataapi slash commands');
         it('should execute tool before LLM call');
         it('should include tool result in conversation');
       });
     });
   });
   ```

2. **Mock Setup** (using Jest):
   ```javascript
   // Mock Ollama API
   const mockOllamaFetch = jest.fn();
   jest.mock('node-fetch', () => mockOllamaFetch);

   // Mock RAG store
   const mockRagStore = {
     search: jest.fn().mockResolvedValue([
       { content: 'Test document', score: 0.9 }
     ])
   };

   // Mock cost calculator
   const mockCostCalculator = {
     calculateMessageCost: jest.fn().mockResolvedValue({
       totalCost: 0.001234,
       currency: 'USD'
     })
   };

   // Mock model router
   const mockModelRouter = {
     getActiveHost: jest.fn().mockReturnValue('http://localhost:11434')
   };
   ```

3. **Test Data Fixtures**:
   ```javascript
   const fixtures = {
     simpleChat: {
       model: 'qwen2.5:7b',
       messages: [
         { role: 'user', content: 'Hello' }
       ],
       options: { useRag: false }
     },
     ragEnabledChat: {
       model: 'qwen2.5:7b',
       messages: [
         { role: 'user', content: 'What is AgentX?' }
       ],
       options: { useRag: true }
     },
     toolCommand: {
       model: 'qwen2.5:7b',
       messages: [
         { role: 'user', content: '/dataapi files search test.txt' }
       ],
       options: {}
     }
   };
   ```

4. **Assertion Helpers**:
   ```javascript
   function assertValidChatResponse(response) {
     expect(response).toHaveProperty('message');
     expect(response.message).toHaveProperty('role', 'assistant');
     expect(response.message).toHaveProperty('content');
     expect(response).toHaveProperty('usage');
   }

   function assertCostCalculated(message) {
     expect(message.cost).toBeDefined();
     expect(message.cost.totalCost).toBeGreaterThanOrEqual(0);
     expect(message.cost.currency).toBe('USD');
   }
   ```

5. **Coverage Report Target**:
   ```
   chatService.js Coverage
   ├── Statements: 80%+
   ├── Branches: 75%+
   ├── Functions: 85%+
   └── Lines: 80%+
   ```

6. **Test Running Instructions**:
   ```bash
   # Run chatService tests only
   npm test -- tests/unit/chatService.test.js

   # Run with coverage
   npm test -- --coverage tests/unit/chatService.test.js

   # Watch mode
   npm test -- --watch tests/unit/chatService.test.js
   ```

### Output Format
JavaScript test file with 30+ test cases + mock setup + fixtures + documentation.

### Success Criteria
- All critical paths covered (routing, RAG, cost, errors, tools)
- Tests are deterministic (no flaky tests)
- Mocks are realistic (match actual API behavior)
- Tests run in < 5 seconds
- Coverage reaches 80% minimum

---

## Task Package 4: Database Schema Design (4 Models for Feature Dashboard)

### Input Context
- Feature Alignment Dashboard needs 4 new database models
- Stack: MongoDB + Mongoose
- Existing patterns: See `models/Conversation.js`, `models/ModelRegistry.js` for schema style

### Task
Design complete Mongoose schemas with validation, indexes, and helper methods.

### Deliverables
1. **FeatureInventory Schema** (`models/FeatureInventory.js`):
   ```javascript
   const FeatureInventorySchema = new mongoose.Schema({
     name: { type: String, required: true, unique: true, index: true },
     category: {
       type: String,
       enum: ['core', 'analytics', 'operations', 'experimental', 'deprecated'],
       required: true
     },
     status: {
       type: String,
       enum: ['complete', 'partial', 'planned', 'orphaned', 'deprecated'],
       required: true
     },

     frontend: {
       exists: Boolean,
       pages: [String],          // ['analytics.html', 'dashboard.html']
       components: [String],      // ['analytics.js', 'cost-chart.js']
       lines: [Number],           // Line numbers where feature appears
       lastVerified: Date
     },

     backend: {
       exists: Boolean,
       services: [String],        // ['costCalculator.js']
       models: [String],          // ['ModelPricingConfig.js']
       routes: [String],          // ['analytics.js']
       endpoints: [String],       // ['/api/analytics/costs']
       lastVerified: Date
     },

     documentation: {
       exists: Boolean,
       files: [String],           // ['COST_TRACKING_SUMMARY.txt']
       completeness: { type: Number, min: 0, max: 100 },
       lastVerified: Date
     },

     roadmap: {
       status: {
         type: String,
         enum: ['complete', 'in-progress', 'planned', 'backlog', 'not-tracked']
       },
       priority: {
         type: String,
         enum: ['critical', 'high', 'medium', 'low']
       },
       lastUpdated: Date
     },

     metadata: {
       description: String,
       tags: [String],
       addedDate: { type: Date, default: Date.now },
       addedBy: String
     }
   });

   // Indexes
   FeatureInventorySchema.index({ category: 1, status: 1 });
   FeatureInventorySchema.index({ 'roadmap.status': 1 });

   // Helper methods
   FeatureInventorySchema.statics.getAlignmentReport = async function() {
     // Returns: { complete: [...], partial: [...], missing: [...] }
   };

   FeatureInventorySchema.methods.calculateAlignmentScore = function() {
     // Returns: 0-100 based on frontend/backend/docs presence
   };
   ```

2. **ApiTelemetry Schema** (`models/ApiTelemetry.js`):
   ```javascript
   const ApiTelemetrySchema = new mongoose.Schema({
     endpoint: { type: String, required: true, index: true },
     method: {
       type: String,
       enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
       required: true
     },

     metrics: {
       hitCount: { type: Number, default: 0 },
       totalDuration: { type: Number, default: 0 },  // Sum in milliseconds
       avgLatency: { type: Number, default: 0 },      // Calculated average
       minLatency: { type: Number, default: Infinity },
       maxLatency: { type: Number, default: 0 },
       p50Latency: Number,  // Median
       p95Latency: Number,  // 95th percentile
       p99Latency: Number,  // 99th percentile
       errorCount: { type: Number, default: 0 },
       lastCalled: Date
     },

     timestamp: { type: Date, default: Date.now, index: true },
     period: {
       type: String,
       enum: ['real-time', 'hourly', 'daily', 'weekly'],
       default: 'hourly'
     }
   });

   // Compound index for time-series queries
   ApiTelemetrySchema.index({ endpoint: 1, timestamp: -1 });
   ApiTelemetrySchema.index({ period: 1, timestamp: -1 });

   // Helper methods
   ApiTelemetrySchema.statics.recordCall = async function(endpoint, method, duration, statusCode) {
     // Upsert telemetry record for current hour
   };

   ApiTelemetrySchema.statics.getTopEndpoints = async function(limit = 10, sortBy = 'hitCount') {
     // Returns: [...endpoints sorted by metric]
   };

   ApiTelemetrySchema.statics.getUnusedEndpoints = async function(sinceDays = 30) {
     // Returns: Endpoints with 0 hits in period
   };
   ```

3. **FeatureUsage Schema** (`models/FeatureUsage.js`):
   ```javascript
   const FeatureUsageSchema = new mongoose.Schema({
     userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
     feature: { type: String, required: true, index: true },
     page: String,
     action: {
       type: String,
       enum: ['viewed', 'clicked', 'completed', 'dismissed'],
       required: true
     },

     metadata: {
       sessionId: String,
       timestamp: { type: Date, default: Date.now, index: true },
       duration: Number,        // Time spent in milliseconds
       context: mongoose.Schema.Types.Mixed
     }
   });

   // Compound indexes for analytics queries
   FeatureUsageSchema.index({ feature: 1, timestamp: -1 });
   FeatureUsageSchema.index({ userId: 1, feature: 1 });

   // Helper methods
   FeatureUsageSchema.statics.getFeatureAdoption = async function(feature, daysBack = 30) {
     // Returns: { totalUsers, activeUsers, adoptionRate, trend }
   };

   FeatureUsageSchema.statics.getUserFeatureProfile = async function(userId) {
     // Returns: User's feature usage patterns
   };
   ```

4. **FeatureFlag Schema** (`models/FeatureFlag.js`):
   ```javascript
   const FeatureFlagSchema = new mongoose.Schema({
     name: { type: String, required: true, unique: true, index: true },
     enabled: { type: Boolean, default: false },
     description: { type: String, required: true },
     scope: {
       type: String,
       enum: ['global', 'user', 'admin'],
       default: 'global'
     },

     config: {
       rolloutPercentage: { type: Number, min: 0, max: 100, default: 100 },
       enabledFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
       disabledFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
       environment: {
         type: String,
         enum: ['development', 'staging', 'production', 'all'],
         default: 'all'
       }
     },

     metadata: {
       createdAt: { type: Date, default: Date.now },
       updatedAt: { type: Date, default: Date.now },
       updatedBy: String,
       reason: String,
       tags: [String]
     }
   });

   // Helper methods
   FeatureFlagSchema.statics.isEnabled = async function(flagName, userId = null) {
     // Check if feature is enabled for user
     // Considers: global enabled, rollout percentage, user-specific overrides
   };

   FeatureFlagSchema.methods.checkRollout = function(userId) {
     // Deterministic rollout check based on userId hash
     // Same user always gets same result for consistency
   };
   ```

5. **Schema Validation Tests**:
   ```javascript
   describe('FeatureInventory Schema', () => {
     it('should require name and category');
     it('should enforce unique name');
     it('should validate status enum');
     it('should calculate alignment score correctly');
   });
   ```

### Output Format
4 JavaScript files (`models/*.js`) + validation tests + helper method documentation.

### Success Criteria
- Schemas match existing AgentX patterns (see Conversation.js, ModelRegistry.js)
- Indexes support efficient queries (< 100ms for dashboard queries)
- Helper methods implemented and documented
- Validation enforces data integrity
- Tests verify schema constraints

---

## Task Package 5: n8n LLM Gateway Workflow Template

### Input Context
- Goal: Create n8n workflow template that exposes cloud LLMs (OpenAI, Anthropic, Google) as webhook endpoints
- Use case: User has OpenAI API key, wants to use GPT-4 in AgentX chat without adding API key to AgentX
- AgentX will call this webhook like it calls Ollama (send prompt, get completion)

### Task
Design n8n workflow JSON template with documentation.

### Deliverables
1. **Workflow JSON** (`/AgentC/n8n.workflows/N6.0-LLM-Gateway.json`):
   ```json
   {
     "name": "N6.0 LLM Gateway - OpenAI",
     "nodes": [
       {
         "name": "Webhook Trigger",
         "type": "n8n-nodes-base.webhook",
         "parameters": {
           "path": "llm-gateway-openai",
           "responseMode": "responseNode",
           "httpMethod": "POST"
         }
       },
       {
         "name": "Extract Prompt",
         "type": "n8n-nodes-base.function",
         "parameters": {
           "functionCode": "// Extract prompt and options from request\nconst { prompt, max_tokens = 1000, temperature = 0.7 } = $json.body;\nreturn { prompt, max_tokens, temperature };"
         }
       },
       {
         "name": "OpenAI Chat",
         "type": "n8n-nodes-base.openAi",
         "parameters": {
           "model": "gpt-4-turbo",
           "messages": "={{ $json.prompt }}",
           "maxTokens": "={{ $json.max_tokens }}",
           "temperature": "={{ $json.temperature }}"
         }
       },
       {
         "name": "Format Response",
         "type": "n8n-nodes-base.function",
         "parameters": {
           "functionCode": "// Format response to match AgentX contract\nreturn {\n  completion: $json.choices[0].message.content,\n  usage: {\n    promptTokens: $json.usage.prompt_tokens,\n    completionTokens: $json.usage.completion_tokens,\n    totalTokens: $json.usage.total_tokens\n  },\n  model: $json.model\n};"
         }
       },
       {
         "name": "Respond to Webhook",
         "type": "n8n-nodes-base.respondToWebhook",
         "parameters": {
           "respondWith": "json"
         }
       }
     ],
     "connections": {
       "Webhook Trigger": { "main": [[{ "node": "Extract Prompt" }]] },
       "Extract Prompt": { "main": [[{ "node": "OpenAI Chat" }]] },
       "OpenAI Chat": { "main": [[{ "node": "Format Response" }]] },
       "Format Response": { "main": [[{ "node": "Respond to Webhook" }]] }
     }
   }
   ```

2. **Variations** (3 templates):
   - N6.0-LLM-Gateway-OpenAI.json (GPT-4)
   - N6.1-LLM-Gateway-Anthropic.json (Claude)
   - N6.2-LLM-Gateway-Google.json (Gemini)

3. **Setup Documentation** (`docs/n8n-llm-gateway.md`):
   ```markdown
   # n8n LLM Gateway Setup

   ## Purpose
   Use cloud LLMs (OpenAI, Anthropic, Google) in AgentX without storing API keys in AgentX.

   ## Prerequisites
   - n8n instance running
   - API key for cloud provider (OpenAI, Anthropic, or Google)

   ## Step 1: Import Workflow
   1. Open n8n
   2. Import N6.0-LLM-Gateway-OpenAI.json
   3. Configure OpenAI credentials (API key)
   4. Activate workflow

   ## Step 2: Get Webhook URL
   1. Click "Webhook Trigger" node
   2. Copy "Test URL" or "Production URL"
   3. Example: https://n8n.specialblend.icu/webhook/llm-gateway-openai

   ## Step 3: Register in AgentX
   1. Open models.html in AgentX
   2. Click "Add Source" → "Add n8n Webhook LLM"
   3. Fill form:
      - Name: "GPT-4 Turbo via n8n"
      - Provider: openai
      - Webhook URL: [paste from step 2]
      - Request template:
        ```json
        {
          "prompt": "{{prompt}}",
          "max_tokens": {{maxTokens}},
          "temperature": {{temperature}}
        }
        ```
      - Response path: `completion`
   4. Click "Test Connection" (should return sample response)
   5. Click "Save"

   ## Step 4: Use in Chat
   1. Open chat interface (index.html)
   2. Select "GPT-4 Turbo via n8n" from model dropdown
   3. Chat normally (AgentX routes to n8n → n8n calls OpenAI → returns completion)

   ## Testing
   ```bash
   # Test webhook directly
   curl -X POST https://n8n.specialblend.icu/webhook/llm-gateway-openai \
     -H "Content-Type: application/json" \
     -d '{
       "prompt": "What is 2+2?",
       "max_tokens": 100,
       "temperature": 0.7
     }'
   ```

   ## Troubleshooting
   - **"Connection failed"**: Check n8n workflow is active
   - **"API key invalid"**: Update OpenAI credentials in n8n
   - **"Rate limit exceeded"**: OpenAI quota reached, wait or upgrade plan
   ```

4. **Contract Specification**:
   ```markdown
   ## n8n LLM Webhook Contract

   ### Request Format
   ```json
   POST /webhook/llm-gateway-{provider}
   Content-Type: application/json

   {
     "prompt": "User message or system+user combined",
     "max_tokens": 1000,
     "temperature": 0.7,
     "top_p": 0.9
   }
   ```

   ### Response Format
   ```json
   {
     "completion": "Assistant response text",
     "usage": {
       "promptTokens": 123,
       "completionTokens": 456,
       "totalTokens": 579
     },
     "model": "gpt-4-turbo"
   }
   ```

   ### Error Format
   ```json
   {
     "error": "Error message",
     "statusCode": 500
   }
   ```
   ```

### Output Format
- 3 n8n workflow JSON files
- 1 setup documentation (markdown)
- 1 contract specification (markdown)

### Success Criteria
- Workflow imports into n8n without errors
- Test request returns valid completion
- AgentX can call webhook and parse response
- Documentation is step-by-step with screenshots/examples
- Works for OpenAI, Anthropic, and Google providers

---

## Task Coordination Notes

### When External Agent Completes Task
1. Agent posts deliverables in shared location (Slack/Discord/Email)
2. I review for completeness (does it match success criteria?)
3. I integrate into AgentX codebase
4. I run validation tests
5. I update ROADMAP.md and CLAUDE.md

### Parallel Execution
You can run multiple task packages simultaneously:
- **Task 1 + Task 3** (UX design + test scaffold) - No dependencies
- **Task 2 + Task 4** (scanning algorithm + schemas) - No dependencies
- **Task 5** (n8n template) - Independent of all others

### Output Format for All Tasks
- Markdown + code files in `/home/yb/codes/AgentX/external-agent-output/task-{N}/`
- Include README.md with: What was delivered, how to integrate, test instructions

---

## Priority Order (If Limited Resources)

1. **Task 3** (chatService tests) - Highest risk mitigation
2. **Task 1** (models.html UX) - Highest user value
3. **Task 4** (schemas) - Enables feature dashboard
4. **Task 2** (scanning algorithm) - Complex logic, good delegation candidate
5. **Task 5** (n8n template) - Nice-to-have, not blocking

---

**Usage**: Copy relevant task package prompt, send to external agent, collect output, I'll integrate.
