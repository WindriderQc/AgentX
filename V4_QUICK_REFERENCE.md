# V4 Quick Reference Card

## 🎯 What V4 Does
**Prompt versioning + analytics + dataset export** for automated improvement loops.

Agent C (n8n) can now:
- Monitor prompt performance
- Export training data
- Generate improved prompts via LLM
- Activate new versions for A/B testing

---

## 📁 New Files

### Models
- `models/PromptConfig.js` - Prompt version control

### Routes
- `routes/analytics.js` - 3 analytics endpoints
- `routes/dataset.js` - 4 dataset endpoints

### Testing
- `test-v4-analytics.sh` - Full API test suite
- `V4_CONTRACT.md` - Complete API documentation
- `V4_IMPLEMENTATION_SUMMARY.md` - What was built

---

## 🔌 API Endpoints

### Analytics (3 endpoints)
```bash
# Usage stats
GET /api/analytics/usage?groupBy=promptVersion

# Feedback metrics
GET /api/analytics/feedback?groupBy=promptVersion

# RAG performance
GET /api/analytics/rag-stats
```

### Dataset (4 endpoints)
```bash
# Export conversations
GET /api/dataset/conversations?minFeedback=1&limit=50

# Create new prompt
POST /api/dataset/prompts
Body: { name, version, systemPrompt, description }

# List prompts
GET /api/dataset/prompts?status=active

# Activate prompt
PATCH /api/dataset/prompts/:id/activate
```

---

## 🚀 Quick Start

### 1. Test the implementation
```bash
./test-v4-analytics.sh
```

### 2. Check active prompt
```bash
curl http://localhost:3080/api/dataset/prompts?status=active | jq
```

### 3. View usage stats
```bash
curl "http://localhost:3080/api/analytics/usage?groupBy=promptVersion" | jq
```

### 4. Create new prompt (example)
```bash
curl -X POST http://localhost:3080/api/dataset/prompts \
  -H "Content-Type: application/json" \
  -d '{
    "name": "default_chat",
    "version": 2,
    "systemPrompt": "You are AgentX v2, optimized for accuracy.",
    "description": "Improved based on feedback",
    "status": "proposed",
    "author": "human"
  }' | jq
```

### 5. Activate prompt
```bash
# Get the prompt ID from step 4, then:
curl -X PATCH http://localhost:3080/api/dataset/prompts/<ID>/activate | jq
```

---

## 🔍 Database Changes

### New Collection
- `promptconfigs` - Stores all prompt versions

### Extended Collection
- `conversations` - Now has:
  - `promptConfigId` (ref to PromptConfig)
  - `promptName` (snapshot)
  - `promptVersion` (snapshot)
  - 6 new indexes for analytics

---

## 📊 Agent C Workflow Example

```
1. Monitor (every 6h):
   GET /api/analytics/feedback?groupBy=promptVersion
   → If positiveRate < 0.7, trigger improvement

2. Export failures:
   GET /api/dataset/conversations?minFeedback=-1&limit=50
   → Collect negative examples

3. Generate (via LLM):
   Use Ollama/OpenAI to analyze failures
   → Generate improved system prompt

4. Propose:
   POST /api/dataset/prompts
   → Create v3 with status='proposed'

5. Activate:
   PATCH /api/dataset/prompts/<id>/activate
   → Deploy v3 to production

6. Validate (next day):
   GET /api/analytics/feedback?groupBy=promptVersion
   → Compare v2 vs v3 performance
```

---

## 📖 Full Documentation

- **API Reference**: `V4_CONTRACT.md` (513 lines)
- **Implementation Details**: `V4_IMPLEMENTATION_SUMMARY.md` (300+ lines)
- **Original Spec**: `specs/V4_ANALYTICS_ARCHITECTURE.md` (Agent A)

---

## ✅ Verification Checklist

After server start, verify:
- [ ] Server logs show: `[V4] Created default_chat v1 (active)`
- [ ] `curl /health` returns 200
- [ ] `./test-v4-analytics.sh` passes all tests
- [ ] MongoDB has `promptconfigs` collection
- [ ] Conversations have `promptVersion` field

---

## 🎓 Key Concepts

### Prompt Versioning
- Each prompt has: name + version (e.g., "default_chat" v1, v2, v3)
- Only ONE version per name can be `active` at a time
- Old versions become `deprecated` when new version activated

### Status Workflow
1. `proposed` - Newly created, awaiting review/testing
2. `active` - Currently used by chat endpoint
3. `deprecated` - Replaced by newer version

### Snapshot Pattern
- Conversations store `promptName` + `promptVersion` (snapshot)
- Enables historical queries even if PromptConfig deleted
- Fast analytics without joins

---

## 🧪 Testing Tips

### Create test conversation
```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "target": "192.168.2.99:11434",
    "model": "llama3.2:latest",
    "messages": [{"role": "user", "content": "Hello"}]
  }' | jq
```

### Add feedback to conversation
```bash
# Edit conversation in MongoDB to add feedback:
db.conversations.updateOne(
  { _id: ObjectId("<id>") },
  { $set: { "messages.1.feedback": { rating: 1, timestamp: new Date() } } }
)
```

### Test analytics with data
1. Create 10+ conversations
2. Add feedback (mix of rating: 1 and -1)
3. Run analytics queries
4. Should see breakdown by promptVersion

---

**Everything ready for automated prompt evolution! 🚀**
