# External Agent Task: RAG Contextual Compression

**Your Mission:** Implement contextual compression for AgentX's RAG system to reduce token usage by 40-60% while maintaining response quality.

**Estimated Effort:** 48-72 hours (3-5 days)
**Priority:** HIGH - Significant cost savings and quality improvements

---

## 🎯 Objective

Build a two-stage RAG pipeline that extracts only relevant sentences from retrieved document chunks before injecting them into LLM prompts. This will:
- Reduce token usage by 40-60%
- Lower costs proportionally
- Improve response quality by removing irrelevant noise
- Maintain full transparency through existing citation system

---

## 📋 Current vs Desired Flow

**Current (Without Compression):**
```
User Query → Vector Search → Full Chunks (2500 tokens) → LLM Prompt
Problem: 60% of context is irrelevant noise
```

**Desired (With Compression):**
```
User Query → Vector Search → Compress Chunks (1000 tokens) → LLM Prompt
Result: 60% token reduction, 100% relevant context
```

---

## 📂 Implementation Phases

### **Phase 1: Backend Service (24-32 hours)**

#### 1.1 Create Compression Service (6-8 hours)

**File:** `/src/services/ragCompression.js` (NEW)

**Requirements:**
- Singleton service using `getCompressionService()` pattern
- Uses fast model (gemma2:2b) for compression
- Caches compressed results for 1 hour (Map-based cache)
- Async parallel processing of chunks
- Graceful degradation on failures (returns original chunk)

**Key Methods:**
```javascript
async compressChunks(query, chunks, options = {})
  - Input: User query + retrieved chunks
  - Output: Compressed chunks with metadata preserved
  - Options: compressionModel, minRelevanceScore, maxSentencesPerChunk, useCache

async _compressChunk(query, chunk, model, minScore, maxSentences)
  - Uses LLM to extract relevant sentences
  - System prompt: "Extract ONLY relevant sentences, preserve exact wording"
  - Returns: { ...chunk, compressedText, originalText, compressionRatio, wasCompressed }
  - Handles "NO_RELEVANT_CONTENT" case (returns empty compressedText)

clearCache()
getCacheStats()
```

**Prompt Engineering (Critical!):**
```
System Prompt:
"You are a sentence extraction assistant. Extract ONLY sentences directly relevant to the query.
Rules:
1. Complete sentences only (no partial)
2. Preserve original wording exactly (no paraphrasing)
3. Keep original order
4. If no relevant content: return 'NO_RELEVANT_CONTENT'
5. Maximum {maxSentences} sentences
6. Only sentences with relevance ≥{minScore}/1.0"

User Prompt:
"Query: {query}
Text to extract from: {chunk.text}
Extract the most relevant sentences:"
```

**Configuration:**
- Model: gemma2:2b (fast, 2B parameters)
- Temperature: 0.1 (low for consistency)
- num_predict: 300 (limit response length)
- Cache TTL: 3600000ms (1 hour)

#### 1.2 Integrate with chatService.js (4-6 hours)

**File:** `/src/services/chatService.js` (MODIFY)

**Changes:**
1. Import: `const { getCompressionService } = require('./ragCompression');`
2. After RAG search, check `options?.ragCompress === true`
3. If enabled, compress chunks before building context
4. Use `compressedText` for prompt, keep `originalText` for citations
5. Track compression metrics in ragSources

**Code Location:** In `sendMessage()` after `ragStore.searchSimilarChunks()` call

**Example:**
```javascript
if (options?.ragCompress === true) {
  const compressionService = getCompressionService();
  processedChunks = await compressionService.compressChunks(
    lastUserMessage,
    searchResults,
    { compressionModel: 'gemma2:2b', minRelevanceScore: 0.6, maxSentencesPerChunk: 5 }
  );
}

ragContext = processedChunks.map((r, i) => {
  const text = r.compressedText || r.text; // Use compressed if available
  return `[Document ${i + 1}]\nSource: ${r.metadata?.filename || 'Unknown'}\n${text}\n`;
}).join('\n');

ragSources = processedChunks.map(r => ({
  // ... existing fields ...
  wasCompressed: r.wasCompressed || false,
  compressionRatio: r.compressionRatio || 0
}));
```

#### 1.3 Add Environment Configuration (1 hour)

**File:** `.env` (ADD)
```bash
# RAG Contextual Compression
COMPRESSION_MODEL=gemma2:2b
COMPRESSION_MIN_RELEVANCE=0.6
COMPRESSION_MAX_SENTENCES=5
COMPRESSION_CACHE_TTL=3600000
```

**File:** `/config/index.js` or equivalent (ADD)
```javascript
compression: {
  model: process.env.COMPRESSION_MODEL || 'gemma2:2b',
  minRelevanceScore: parseFloat(process.env.COMPRESSION_MIN_RELEVANCE) || 0.6,
  maxSentencesPerChunk: parseInt(process.env.COMPRESSION_MAX_SENTENCES) || 5,
  cacheTTL: parseInt(process.env.COMPRESSION_CACHE_TTL) || 3600000
}
```

#### 1.4 Update Chat Route (2 hours)

**File:** `/routes/chat.js` (MODIFY)

**Changes:**
1. Extract `ragCompress` from `req.body.ragCompress`
2. Pass to chatService as `ragCompress: req.body.ragCompress === true`

---

### **Phase 2: Frontend UI (8-12 hours)**

#### 2.1 Add Compression Checkbox (2 hours)

**File:** `/public/index.html` or `/public/chat.html` (MODIFY)

**Location:** In RAG advanced options section (near ragExpand, ragHybrid, ragRerank)

**HTML:**
```html
<label class="rag-checkbox-wrapper" title="LLM extracts only relevant sentences from chunks">
  <input type="checkbox" id="ragCompress" />
  <span>Contextual Compression <span class="latency-badge">+500ms</span></span>
  <span class="benefit-badge">-50% tokens</span>
</label>
```

**CSS (ADD):**
```css
.benefit-badge {
  margin-left: 6px;
  padding: 2px 6px;
  background: rgba(25, 135, 84, 0.15);
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #198754;
}
```

#### 2.2 Wire Up JavaScript (2 hours)

**File:** `/public/js/chat.js` (MODIFY)

**In sendMessage() function:**
```javascript
const ragCompress = document.getElementById('ragCompress')?.checked;

const body = {
  message: userMessage,
  model: currentModel,
  useRAG: useRAG,
  ragCompress: useRAG && ragCompress,  // NEW
  // ... other options
};
```

#### 2.3 Add localStorage Persistence (1 hour)

**File:** `/public/js/chat.js` (MODIFY)

**On page load:**
```javascript
document.addEventListener('DOMContentLoaded', () => {
  const ragCompress = localStorage.getItem('rag_compress') === 'true';
  document.getElementById('ragCompress').checked = ragCompress;
});
```

**On checkbox change:**
```javascript
document.getElementById('ragCompress').addEventListener('change', (e) => {
  localStorage.setItem('rag_compress', e.target.checked);
});
```

#### 2.4 Display Compression Metrics (3-4 hours)

**File:** `/public/js/chat.js` (MODIFY)

**Enhance buildSourcesSection() function:**
```javascript
const compressionBadge = src.wasCompressed
  ? `<span class="compression-badge">🗜️ ${src.compressionRatio}% compressed</span>`
  : '';

// Add to source item HTML
<div class="source-metadata">
  <span class="source-score">Relevance: ${score}%</span>
  ${compressionBadge}
  ${tags}
</div>
```

**CSS (ADD):**
```css
.compression-badge {
  display: inline-block;
  padding: 2px 8px;
  background: rgba(25, 135, 84, 0.1);
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #198754;
  margin-left: 8px;
}
```

---

### **Phase 3: Testing & Validation (8-12 hours)**

#### 3.1 Unit Tests (4 hours)

**File:** `/tests/unit/ragCompression.test.js` (NEW)

**Test Cases:**
1. ✅ Should compress chunks with relevant content
2. ✅ Should handle chunks with no relevant content
3. ✅ Should use cache for repeated queries
4. ✅ Should preserve metadata in compressed chunks
5. ✅ Should handle compression errors gracefully

**Coverage Target:** >80% for compression service

#### 3.2 Integration Tests (4 hours)

**File:** `/tests/integration/rag-compression.test.js` (NEW)

**Test Cases:**
1. ✅ Should compress RAG context when ragCompress=true
2. ✅ Should not compress when ragCompress=false
3. ✅ Should return compression metrics in response

**Coverage Target:** End-to-end chat flow with compression

#### 3.3 Performance Benchmarking (2-4 hours)

**Script:** `/scripts/benchmark-compression.js` (NEW)

**Metrics to Measure:**
- Compression time per chunk (target: <500ms)
- Token savings percentage (target: 40-60%)
- Cache hit rate (target: >50% after 1 hour)
- Response quality (manual validation: no accuracy loss)

**Output:** Console table with results + averages

---

## ✅ Success Criteria

**Backend:**
- ✅ RAGCompressionService singleton implemented with caching
- ✅ Integrated into chatService with ragCompress flag
- ✅ Environment configuration added
- ✅ Graceful degradation on failures
- ✅ Compression time <500ms per chunk

**Frontend:**
- ✅ Compression checkbox in RAG options
- ✅ localStorage persistence
- ✅ Compression metrics in citations
- ✅ Latency/benefit badges

**Quality:**
- ✅ 40-60% average token reduction
- ✅ No accuracy loss (manual validation)
- ✅ Cache hit rate >50%

**Testing:**
- ✅ 5+ unit tests passing
- ✅ 3+ integration tests passing
- ✅ Performance benchmarks documented

---

## 🔧 Implementation Tips

### 1. Start with Compression Service
Build `/src/services/ragCompression.js` in isolation first. Test independently before integrating.

### 2. Prompt Engineering is Critical
The quality of compression depends entirely on the LLM prompt. Use:
- **Strict extraction** (recommended): "Extract ONLY relevant sentences, preserve exact wording"
- **Low temperature** (0.1): For consistency
- **Clear rules**: Complete sentences, no paraphrasing, original order

### 3. Use Fast Models
Recommended compression models:
- **gemma2:2b** (best speed/accuracy)
- phi3:mini (3.8B, very fast)
- llama3.1:8b (slower but more accurate)

### 4. Cache Aggressively
Compression is expensive. Cache results for:
- Same query + same chunk = instant return
- TTL of 1 hour (configurable)
- Clear cache on document updates

### 5. Handle Edge Cases
- No relevant content → Return empty compressedText (filtered out)
- Compression failure → Fallback to original chunk
- Empty chunks → Filter out before returning

### 6. Measure Token Costs
Track before/after token usage to ensure compression saves more than it costs:
```javascript
const originalTokens = estimateTokens(chunks);
const compressedTokens = estimateTokens(compressed, 'compressedText');
const savingsPercent = ((originalTokens - compressedTokens) / originalTokens * 100).toFixed(1);
```

---

## 📊 Expected Impact

**Token Savings:**
- Before: 5 chunks × 500 tokens = 2,500 tokens
- After: 5 chunks × 200 tokens = 1,000 tokens (compression overhead: +200)
- **Net Savings: 52% (1,300 tokens saved)**

**Response Quality:**
- Expected: No loss (same accuracy)
- Reason: Removes irrelevant sentences, not relevant info

**Latency:**
- Compression: +300-700ms
- Faster LLM processing: -200-400ms
- **Net Impact: +100-300ms (acceptable for 52% savings)**

---

## 🗂️ Files to Create/Modify

**Create:**
- `/src/services/ragCompression.js` (400+ lines)
- `/tests/unit/ragCompression.test.js` (150+ lines)
- `/tests/integration/rag-compression.test.js` (100+ lines)
- `/scripts/benchmark-compression.js` (100+ lines)

**Modify:**
- `/src/services/chatService.js` (add compression integration)
- `/routes/chat.js` (extract ragCompress flag)
- `/public/index.html` or `/public/chat.html` (add checkbox)
- `/public/js/chat.js` (wire up UI + metrics)
- `.env` (add compression config)
- `/config/index.js` (add compression config)

---

## 📖 Documentation Reference

**Full Specification:** `/EXTERNAL_AGENT_NEXT_RAG_CONTEXTUAL_COMPRESSION.md` (900+ lines)
- Read this for detailed implementation examples
- Contains full code snippets for all components
- Includes testing strategy and benchmarking scripts

**Related Docs:**
- `/docs/features/RAG_SEARCH_FEATURES.md` (RAG system overview)
- `/docs/architecture/RAG_SYSTEM.md` (RAG architecture)

---

## 🚀 Quick Start Instructions

1. **Read the full spec:** `/EXTERNAL_AGENT_NEXT_RAG_CONTEXTUAL_COMPRESSION.md`
2. **Start with backend:** Create `/src/services/ragCompression.js`
3. **Test in isolation:** Unit tests first
4. **Integrate:** Add to chatService.js
5. **Add UI:** Compression checkbox and metrics
6. **Validate:** Run benchmarks and manual testing

**Estimated Timeline:** 3-5 days full-time (48-72 hours)

---

**Ready to implement!** This feature delivers massive cost savings (40-60% token reduction) while maintaining quality and transparency. Good luck! 🚀
