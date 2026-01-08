# External Agent Task: RAG Contextual Compression

**Date:** 2026-01-08
**Estimated Effort:** 48-72 hours (3-5 days)
**Priority:** HIGH - Reduces context size by 40-60%, improves quality & lowers costs
**Agent Type:** Backend (Service Layer)

---

## Context

**Problem:** When AgentX retrieves document chunks via RAG, entire chunks (often 500-1000 tokens) are injected into the LLM prompt. However, only 20-40% of each chunk is actually relevant to the user's query. This wastes tokens, increases costs, and potentially dilutes response quality with irrelevant information.

**Solution:** Implement contextual compression where an LLM extracts only the relevant sentences from each chunk before injecting into the main prompt. This creates a two-stage RAG pipeline:

```
Stage 1: Retrieve chunks (vector search)
Stage 2: Compress chunks (extract relevant sentences)
Stage 3: Inject compressed context into prompt
```

**Documentation Reference:** `/docs/features/RAG_SEARCH_FEATURES.md` (lines 128-132)

---

## Current RAG Flow (Without Compression)

```
User Query: "How does the RAG system work?"
    ↓
Vector Search → Retrieves 5 chunks (2500 tokens total)
    ↓
Full chunks injected into prompt:
[Document 1]
The AgentX system is a comprehensive platform for AI orchestration. It includes
multiple components including chat interfaces, model management, and analytics
dashboards. The RAG system is one of these components. It uses vector embeddings
to enable semantic search across documents. The system integrates with Qdrant as
the vector database. Users can upload documents via the UI or API. The ingestion
pipeline processes documents and creates embeddings using the nomic-embed-text
model. Retrieved chunks are then injected into LLM prompts.
(~150 tokens, only 40% relevant)
```

**Problem:** 60% of the context (90 tokens) is irrelevant noise about chat interfaces, analytics, and UI details.

---

## Desired RAG Flow (With Compression)

```
User Query: "How does the RAG system work?"
    ↓
Vector Search → Retrieves 5 chunks (2500 tokens total)
    ↓
Contextual Compression (LLM extracts relevant sentences):
[Document 1]
"The RAG system uses vector embeddings to enable semantic search across documents.
The system integrates with Qdrant as the vector database. The ingestion pipeline
processes documents and creates embeddings using the nomic-embed-text model.
Retrieved chunks are then injected into LLM prompts."
(~60 tokens, 100% relevant)
    ↓
Compressed context injected into main prompt
```

**Result:** 60% token reduction, higher quality context, faster responses, lower costs.

---

## Phase 1: Compression Service Implementation (24-32 hours)

### 1.1 Create Compression Service (6-8 hours)

**File:** `/src/services/ragCompression.js` (NEW)

**Core Algorithm:**

```javascript
/**
 * RAG Contextual Compression Service
 * Uses an LLM to extract only relevant sentences from retrieved chunks
 */

const logger = require('../config/logger');
const ollamaService = require('./ollamaService');

class RAGCompressionService {
  constructor() {
    // Use a fast, small model for compression
    this.compressionModel = process.env.COMPRESSION_MODEL || 'gemma2:2b';
    this.compressionCache = new Map(); // Cache compressed results
    this.cacheTTL = 3600000; // 1 hour
  }

  /**
   * Compress retrieved chunks by extracting relevant sentences
   * @param {string} query - User's original query
   * @param {Array} chunks - Retrieved RAG chunks with text and metadata
   * @param {Object} options - Compression options
   * @returns {Promise<Array>} Compressed chunks with original metadata preserved
   */
  async compressChunks(query, chunks, options = {}) {
    const {
      compressionModel = this.compressionModel,
      minRelevanceScore = 0.6,  // Only keep sentences scoring ≥0.6
      maxSentencesPerChunk = 5,  // Limit to prevent over-compression
      useCache = true
    } = options;

    if (!chunks || chunks.length === 0) {
      return [];
    }

    logger.info('Starting contextual compression', {
      query: query.substring(0, 50) + '...',
      chunkCount: chunks.length,
      originalTokens: this._estimateTokens(chunks)
    });

    const compressionPromises = chunks.map(async (chunk, index) => {
      // Check cache first
      const cacheKey = `${query}:${chunk._id}`;
      if (useCache && this.compressionCache.has(cacheKey)) {
        const cached = this.compressionCache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTTL) {
          logger.debug('Compression cache hit', { chunkId: chunk._id });
          return cached.result;
        }
      }

      // Perform compression
      const compressed = await this._compressChunk(
        query,
        chunk,
        compressionModel,
        minRelevanceScore,
        maxSentencesPerChunk
      );

      // Cache result
      if (useCache) {
        this.compressionCache.set(cacheKey, {
          result: compressed,
          timestamp: Date.now()
        });
      }

      return compressed;
    });

    const compressedChunks = await Promise.all(compressionPromises);

    // Filter out chunks that became empty after compression
    const validChunks = compressedChunks.filter(c => c.compressedText.length > 0);

    logger.info('Compression complete', {
      originalChunks: chunks.length,
      compressedChunks: validChunks.length,
      originalTokens: this._estimateTokens(chunks),
      compressedTokens: this._estimateTokens(validChunks, 'compressedText'),
      reductionPercent: this._calculateReduction(chunks, validChunks)
    });

    return validChunks;
  }

  /**
   * Compress a single chunk
   * @private
   */
  async _compressChunk(query, chunk, model, minScore, maxSentences) {
    const systemPrompt = `You are a sentence extraction assistant. Your task is to extract ONLY the sentences from the given text that are directly relevant to answering the user's query.

Rules:
1. Extract complete sentences only (no partial sentences)
2. Preserve original wording exactly (no paraphrasing)
3. Keep sentences in original order
4. If no sentences are relevant, return "NO_RELEVANT_CONTENT"
5. Maximum ${maxSentences} sentences
6. Only include sentences with relevance score ≥${minScore}/1.0

Format your response as:
[Sentence 1]
[Sentence 2]
...`;

    const userPrompt = `Query: "${query}"

Text to extract from:
${chunk.text}

Extract the most relevant sentences:`;

    try {
      const response = await ollamaService.generateCompletion({
        model,
        prompt: userPrompt,
        system: systemPrompt,
        stream: false,
        options: {
          temperature: 0.1,  // Low temperature for consistency
          num_predict: 300   // Limit response length
        }
      });

      let extractedText = response.response.trim();

      // Handle "no content" case
      if (extractedText === 'NO_RELEVANT_CONTENT' || extractedText.length < 10) {
        logger.debug('No relevant content found in chunk', {
          chunkId: chunk._id,
          query: query.substring(0, 50)
        });
        return {
          ...chunk,
          compressedText: '',
          originalText: chunk.text,
          compressionRatio: 0,
          wasCompressed: true
        };
      }

      // Calculate compression ratio
      const originalLength = chunk.text.length;
      const compressedLength = extractedText.length;
      const compressionRatio = ((originalLength - compressedLength) / originalLength * 100).toFixed(1);

      return {
        ...chunk,
        compressedText: extractedText,
        originalText: chunk.text,
        compressionRatio: parseFloat(compressionRatio),
        wasCompressed: true
      };

    } catch (error) {
      logger.error('Compression failed for chunk', {
        error: error.message,
        chunkId: chunk._id
      });

      // Fallback: return original chunk
      return {
        ...chunk,
        compressedText: chunk.text,
        originalText: chunk.text,
        compressionRatio: 0,
        wasCompressed: false,
        compressionError: error.message
      };
    }
  }

  /**
   * Estimate token count
   * @private
   */
  _estimateTokens(chunks, textField = 'text') {
    return chunks.reduce((total, chunk) => {
      const text = chunk[textField] || '';
      return total + Math.ceil(text.length / 4); // Rough estimate: 4 chars ≈ 1 token
    }, 0);
  }

  /**
   * Calculate compression reduction percentage
   * @private
   */
  _calculateReduction(originalChunks, compressedChunks) {
    const originalTokens = this._estimateTokens(originalChunks);
    const compressedTokens = this._estimateTokens(compressedChunks, 'compressedText');
    return ((originalTokens - compressedTokens) / originalTokens * 100).toFixed(1);
  }

  /**
   * Clear compression cache
   */
  clearCache() {
    this.compressionCache.clear();
    logger.info('Compression cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.compressionCache.size,
      ttl: this.cacheTTL
    };
  }
}

// Export singleton
let instance = null;
function getCompressionService() {
  if (!instance) {
    instance = new RAGCompressionService();
  }
  return instance;
}

module.exports = { getCompressionService };
```

**Key Design Decisions:**

1. **Small Fast Model:** Uses gemma2:2b for compression (fast, low cost)
2. **Caching:** Caches compressed results for 1 hour to avoid re-compression
3. **Graceful Degradation:** Falls back to original chunk if compression fails
4. **Metadata Preservation:** Keeps all original metadata (score, filename, etc.)
5. **Async Processing:** Compresses chunks in parallel for speed

### 1.2 Integrate with chatService.js (4-6 hours)

**File:** `/src/services/chatService.js`

**Modifications:**

```javascript
const { getCompressionService } = require('./ragCompression');

// In sendMessage() function, after RAG search:

if (useRAG) {
  const searchResults = await ragStore.searchSimilarChunks(lastUserMessage, {
    topK: 5,
    minScore: 0.25,
    filters: ragFilters,
    ollamaHost,
    expandQuery: options?.ragExpand === true,
    rerankResults: options?.ragRerank === true,
    hybridSearch: options?.ragHybrid === true
  });

  let ragSources = [];

  if (searchResults.length > 0) {
    // NEW: Apply contextual compression if enabled
    let processedChunks = searchResults;

    if (options?.ragCompress === true) {
      const compressionService = getCompressionService();
      processedChunks = await compressionService.compressChunks(
        lastUserMessage,
        searchResults,
        {
          compressionModel: process.env.COMPRESSION_MODEL || 'gemma2:2b',
          minRelevanceScore: 0.6,
          maxSentencesPerChunk: 5
        }
      );

      logger.info('RAG compression applied', {
        originalChunks: searchResults.length,
        compressedChunks: processedChunks.length,
        reductionPercent: processedChunks[0]?.compressionRatio || 0
      });
    }

    // Build context from compressed chunks
    ragContext = processedChunks
      .map((r, i) => {
        const text = r.compressedText || r.text; // Use compressed if available
        return `[Document ${i + 1}]\nSource: ${r.metadata?.filename || 'Unknown'}\n${text}\n`;
      })
      .join('\n');

    systemPrompt += `\n\nRelevant context:\n${ragContext}`;

    // Store sources (keep original for citation tracking)
    ragSources = processedChunks.map((r, i) => ({
      chunkId: r._id,
      score: r.score,
      excerpt: (r.compressedText || r.text).substring(0, 200) + '...',
      metadata: {
        filename: r.metadata?.filename || 'Unknown',
        source: r.metadata?.source || '',
        tags: r.metadata?.tags || [],
        timestamp: r.metadata?.timestamp || null,
        pageNumber: r.metadata?.pageNumber || null,
        section: r.metadata?.section || null
      },
      wasCompressed: r.wasCompressed || false,
      compressionRatio: r.compressionRatio || 0
    }));
  }
}
```

**Key Integration Points:**

1. Check `options?.ragCompress` flag from frontend
2. Apply compression after search but before context building
3. Use compressed text for prompt, original for citations
4. Track compression metrics in ragSources

### 1.3 Add Environment Configuration (1 hour)

**File:** `.env`

```bash
# RAG Contextual Compression
COMPRESSION_MODEL=gemma2:2b
COMPRESSION_MIN_RELEVANCE=0.6
COMPRESSION_MAX_SENTENCES=5
COMPRESSION_CACHE_TTL=3600000  # 1 hour in ms
```

**File:** `/config/index.js` (or equivalent config file)

```javascript
module.exports = {
  // ... existing config
  compression: {
    model: process.env.COMPRESSION_MODEL || 'gemma2:2b',
    minRelevanceScore: parseFloat(process.env.COMPRESSION_MIN_RELEVANCE) || 0.6,
    maxSentencesPerChunk: parseInt(process.env.COMPRESSION_MAX_SENTENCES) || 5,
    cacheTTL: parseInt(process.env.COMPRESSION_CACHE_TTL) || 3600000
  }
};
```

### 1.4 Add Compression Toggle to Chat Route (2 hours)

**File:** `/routes/chat.js`

```javascript
// Extract compression flag from request
const ragCompress = req.body.ragCompress === true;

const response = await chatService.sendMessage({
  // ... existing params
  ragCompress,  // NEW: Pass to chatService
});
```

---

## Phase 2: Frontend UI Controls (8-12 hours)

### 2.1 Add Compression Checkbox to Chat UI (2 hours)

**File:** `/public/index.html` (or `/public/chat.html`)

**Add to RAG advanced options section:**

```html
<div class="rag-advanced-options">
  <!-- Existing options -->
  <label class="rag-checkbox-wrapper" title="LLM generates related queries">
    <input type="checkbox" id="ragExpand" />
    <span>Query Expansion <span class="latency-badge">+300ms</span></span>
  </label>

  <label class="rag-checkbox-wrapper" title="Combines vector + keyword search">
    <input type="checkbox" id="ragHybrid" />
    <span>Hybrid Search <span class="latency-badge">+75ms</span></span>
  </label>

  <label class="rag-checkbox-wrapper" title="LLM judges relevance">
    <input type="checkbox" id="ragRerank" />
    <span>Re-ranking <span class="latency-badge">+1000ms</span></span>
  </label>

  <!-- NEW: Contextual Compression -->
  <label class="rag-checkbox-wrapper" title="LLM extracts only relevant sentences from chunks">
    <input type="checkbox" id="ragCompress" />
    <span>Contextual Compression <span class="latency-badge">+500ms</span></span>
    <span class="benefit-badge">-50% tokens</span>
  </label>
</div>
```

**CSS for Benefit Badge:**

```css
.benefit-badge {
  margin-left: 6px;
  padding: 2px 6px;
  background: rgba(25, 135, 84, 0.15);  /* Green tint */
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #198754;
}
```

### 2.2 Wire Up JavaScript (2 hours)

**File:** `/public/js/chat.js`

**In sendMessage() function:**

```javascript
const useRAG = document.getElementById('useRAG')?.checked;
const ragExpand = document.getElementById('ragExpand')?.checked;
const ragHybrid = document.getElementById('ragHybrid')?.checked;
const ragRerank = document.getElementById('ragRerank')?.checked;
const ragCompress = document.getElementById('ragCompress')?.checked;  // NEW

const body = {
  message: userMessage,
  model: currentModel,
  useRAG: useRAG,
  ragExpand: useRAG && ragExpand,
  ragRerank: useRAG && ragRerank,
  ragHybrid: useRAG && ragHybrid,
  ragCompress: useRAG && ragCompress,  // NEW
  // ... other options
};
```

### 2.3 Add localStorage Persistence (1 hour)

**File:** `/public/js/chat.js`

**On page load:**

```javascript
document.addEventListener('DOMContentLoaded', () => {
  // Restore compression preference
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

### 2.4 Display Compression Metrics in Citations (3-4 hours)

**Goal:** Show compression ratio in source references

**File:** `/public/js/chat.js`

**Enhance buildSourcesSection() function:**

```javascript
function buildSourcesSection(sources) {
  if (!sources || sources.length === 0) return '';

  const sourceItems = sources.map((src, index) => {
    const score = Math.round(src.score * 100);
    const tags = src.metadata.tags?.map(tag =>
      `<span class="tag">${tag}</span>`
    ).join('') || '';

    // NEW: Show compression info
    const compressionBadge = src.wasCompressed
      ? `<span class="compression-badge">🗜️ ${src.compressionRatio}% compressed</span>`
      : '';

    return `
      <div class="source-item" data-citation="${index}">
        <div class="source-number">[${index + 1}]</div>
        <div class="source-details">
          <div class="source-title">${src.metadata.filename}</div>
          <div class="source-excerpt">${src.excerpt}</div>
          <div class="source-metadata">
            <span class="source-score">Relevance: ${score}%</span>
            ${compressionBadge}
            ${tags ? `<span class="source-tags">${tags}</span>` : ''}
          </div>
        </div>
        <button class="view-full-document" data-chunk-id="${src.chunkId}">
          View Full
        </button>
      </div>
    `;
  }).join('');

  return `
    <div class="sources-section">
      <div class="sources-header">
        <i class="icon-book"></i>
        <span>Sources (${sources.length})</span>
        <button class="toggle-sources">▼</button>
      </div>
      <div class="sources-list">${sourceItems}</div>
    </div>
  `;
}
```

**CSS for Compression Badge:**

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

### 2.5 Add Compression Analytics Dashboard (Optional, 2-3 hours)

**Goal:** Show compression effectiveness metrics

**File:** `/public/analytics.html` (or create `/public/rag-analytics.html`)

**Metrics to Display:**
- Average compression ratio
- Token savings per conversation
- Cost savings estimate
- Compression cache hit rate
- Failed compressions (fallback to original)

---

## Phase 3: Testing & Optimization (8-12 hours)

### 3.1 Unit Tests (4 hours)

**File:** `/tests/unit/ragCompression.test.js` (NEW)

```javascript
const { getCompressionService } = require('../../src/services/ragCompression');

describe('RAG Compression Service', () => {
  let compressionService;

  beforeEach(() => {
    compressionService = getCompressionService();
    compressionService.clearCache();
  });

  test('should compress chunks with relevant content', async () => {
    const query = 'How does RAG work?';
    const chunks = [
      {
        _id: 'chunk1',
        text: 'AgentX is a platform. It has many features. The RAG system uses vector embeddings. It integrates with Qdrant. Users can upload documents.',
        score: 0.85,
        metadata: { filename: 'docs.md' }
      }
    ];

    const compressed = await compressionService.compressChunks(query, chunks);

    expect(compressed).toHaveLength(1);
    expect(compressed[0].compressedText).toBeTruthy();
    expect(compressed[0].compressedText.length).toBeLessThan(chunks[0].text.length);
    expect(compressed[0].wasCompressed).toBe(true);
    expect(compressed[0].compressionRatio).toBeGreaterThan(0);
  });

  test('should handle chunks with no relevant content', async () => {
    const query = 'How does RAG work?';
    const chunks = [
      {
        _id: 'chunk1',
        text: 'The weather is nice today. I like pizza. JavaScript is a programming language.',
        score: 0.50,
        metadata: { filename: 'irrelevant.md' }
      }
    ];

    const compressed = await compressionService.compressChunks(query, chunks);

    // Should filter out or return empty
    expect(compressed.length).toBeLessThanOrEqual(1);
    if (compressed.length === 1) {
      expect(compressed[0].compressedText).toBe('');
    }
  });

  test('should use cache for repeated queries', async () => {
    const query = 'How does RAG work?';
    const chunks = [
      {
        _id: 'chunk1',
        text: 'The RAG system uses vector embeddings.',
        score: 0.85,
        metadata: { filename: 'docs.md' }
      }
    ];

    // First call - should compress
    const result1 = await compressionService.compressChunks(query, chunks);

    // Second call - should use cache
    const result2 = await compressionService.compressChunks(query, chunks);

    expect(result1).toEqual(result2);
  });

  test('should preserve metadata in compressed chunks', async () => {
    const query = 'Database info';
    const chunks = [
      {
        _id: 'chunk1',
        text: 'MongoDB is used. Qdrant is used. Redis is used.',
        score: 0.90,
        metadata: {
          filename: 'architecture.md',
          tags: ['database', 'qdrant'],
          pageNumber: 5
        }
      }
    ];

    const compressed = await compressionService.compressChunks(query, chunks);

    expect(compressed[0].metadata).toEqual(chunks[0].metadata);
    expect(compressed[0]._id).toBe('chunk1');
    expect(compressed[0].score).toBe(0.90);
  });
});
```

### 3.2 Integration Tests (4 hours)

**File:** `/tests/integration/rag-compression.test.js` (NEW)

```javascript
const request = require('supertest');
const app = require('../../src/app');

describe('RAG Compression Integration', () => {
  test('should compress RAG context when ragCompress=true', async () => {
    const response = await request(app)
      .post('/api/chat')
      .send({
        message: 'How does the RAG system work?',
        model: 'llama3.1:8b',
        useRAG: true,
        ragCompress: true
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.data.ragSources).toBeDefined();

    // Check if compression was applied
    const compressedSources = response.body.data.ragSources.filter(s => s.wasCompressed);
    expect(compressedSources.length).toBeGreaterThan(0);

    // Verify compression ratio
    compressedSources.forEach(source => {
      expect(source.compressionRatio).toBeGreaterThan(0);
      expect(source.compressionRatio).toBeLessThan(100);
    });
  });

  test('should not compress when ragCompress=false', async () => {
    const response = await request(app)
      .post('/api/chat')
      .send({
        message: 'How does the RAG system work?',
        model: 'llama3.1:8b',
        useRAG: true,
        ragCompress: false
      });

    expect(response.status).toBe(200);

    // Check that sources are not marked as compressed
    if (response.body.data.ragSources) {
      const compressedSources = response.body.data.ragSources.filter(s => s.wasCompressed);
      expect(compressedSources.length).toBe(0);
    }
  });
});
```

### 3.3 Performance Benchmarking (2-4 hours)

**Goal:** Measure compression impact on latency and token usage

**Benchmark Test:**

```javascript
// Test script: /scripts/benchmark-compression.js

const { getCompressionService } = require('../src/services/ragCompression');
const { getRagStore } = require('../src/services/ragStore');

async function benchmarkCompression() {
  const queries = [
    'How does the RAG system work?',
    'What database is used?',
    'Explain the authentication system'
  ];

  const compressionService = getCompressionService();
  const ragStore = getRagStore();

  const results = [];

  for (const query of queries) {
    // Search for chunks
    const chunks = await ragStore.searchSimilarChunks(query, { topK: 5 });

    // Measure compression time
    const startTime = Date.now();
    const compressed = await compressionService.compressChunks(query, chunks);
    const compressionTime = Date.now() - startTime;

    // Calculate metrics
    const originalTokens = estimateTokens(chunks);
    const compressedTokens = estimateTokens(compressed, 'compressedText');
    const tokenSavings = originalTokens - compressedTokens;
    const savingsPercent = (tokenSavings / originalTokens * 100).toFixed(1);

    results.push({
      query,
      originalChunks: chunks.length,
      compressedChunks: compressed.length,
      originalTokens,
      compressedTokens,
      tokenSavings,
      savingsPercent,
      compressionTime
    });
  }

  console.table(results);

  const avgSavings = results.reduce((sum, r) => sum + parseFloat(r.savingsPercent), 0) / results.length;
  const avgTime = results.reduce((sum, r) => sum + r.compressionTime, 0) / results.length;

  console.log(`\nAverage token savings: ${avgSavings.toFixed(1)}%`);
  console.log(`Average compression time: ${avgTime}ms`);
}

function estimateTokens(chunks, textField = 'text') {
  return chunks.reduce((total, chunk) => {
    const text = chunk[textField] || '';
    return total + Math.ceil(text.length / 4);
  }, 0);
}

benchmarkCompression().catch(console.error);
```

**Expected Benchmarks:**
- Compression time: 300-700ms per chunk (parallel processing)
- Token savings: 40-60% average
- Quality: No loss in response accuracy (manual review)

---

## Success Criteria

✅ **Backend Complete:**
- RAGCompressionService implemented with caching
- Integrated into chatService with ragCompress flag
- Environment configuration added
- Graceful degradation on compression failures

✅ **Frontend Complete:**
- Compression checkbox in RAG advanced options
- localStorage persistence
- Compression metrics displayed in citations
- Latency and benefit badges

✅ **Quality:**
- 40-60% average token reduction
- Compression time <500ms per chunk
- No accuracy loss (manual validation)
- Cache hit rate >50% after 1 hour

✅ **Testing:**
- Unit tests for compression service (5+ tests)
- Integration tests for chat endpoint (3+ tests)
- Performance benchmarks documented
- Edge cases handled (no relevant content, compression errors)

---

## Implementation Tips

### Tip 1: Start with Compression Service

Build and test `ragCompression.js` in isolation before integrating into chatService. This allows you to:
- Test compression logic independently
- Measure performance without chat complexity
- Iterate on prompt engineering for better extraction

### Tip 2: Prompt Engineering is Critical

The quality of compression depends entirely on the LLM prompt. Test variations:

**Option 1: Strict Extraction (Recommended)**
```
Extract ONLY the sentences directly relevant to the query.
Preserve exact wording. No paraphrasing.
```

**Option 2: Lenient Extraction**
```
Extract sentences that might help answer the query.
Include context sentences even if not directly relevant.
```

**Option 3: Summarization (Alternative)**
```
Summarize the most relevant information in 2-3 sentences.
Preserve key facts and details.
```

Start with Option 1 for maximum precision.

### Tip 3: Use Fast Models for Compression

Compression model should be:
- **Fast:** <500ms per chunk
- **Small:** 2B-7B parameters
- **Accurate:** Good at instruction following

Recommended models:
- gemma2:2b (best speed/accuracy balance)
- phi3:mini (3.8B, very fast)
- llama3.1:8b (slower but more accurate)

### Tip 4: Cache Aggressively

Compression is expensive. Cache results for:
- Same query + same chunk = instant return
- TTL of 1 hour (configurable)
- Clear cache on document updates

### Tip 5: Measure Token Costs

Track before/after token usage:

```javascript
const costPerToken = 0.0001; // Example pricing
const originalCost = originalTokens * costPerToken;
const compressedCost = (compressedTokens + compressionTokens) * costPerToken;
const netSavings = originalCost - compressedCost;
```

Ensure compression saves more than it costs!

---

## Optional Enhancements (If Time Permits)

### Enhancement 1: Adaptive Compression (4 hours)

Adjust compression aggressiveness based on chunk count:

```javascript
if (chunks.length > 10) {
  // Aggressive: Extract 1-2 sentences per chunk
  maxSentencesPerChunk = 2;
  minRelevanceScore = 0.8;
} else if (chunks.length > 5) {
  // Moderate: Extract 3-4 sentences per chunk
  maxSentencesPerChunk = 4;
  minRelevanceScore = 0.6;
} else {
  // Light: Extract 5-6 sentences per chunk
  maxSentencesPerChunk = 6;
  minRelevanceScore = 0.5;
}
```

### Enhancement 2: Compression Analytics API (3 hours)

**New Endpoint:** GET `/api/analytics/compression`

Returns:
- Average compression ratio (last 24 hours)
- Token savings total
- Cost savings estimate
- Cache hit rate
- Failed compressions

### Enhancement 3: User-Configurable Settings (2 hours)

Allow users to adjust compression aggressiveness:

```html
<select id="compressionLevel">
  <option value="light">Light (60% original)</option>
  <option value="medium" selected>Medium (40% original)</option>
  <option value="aggressive">Aggressive (20% original)</option>
</select>
```

---

## Estimated Timeline

| Phase | Effort | Description |
|-------|--------|-------------|
| **Phase 1: Backend** | 24-32 hours | Compression service + integration |
| - Compression service | 6-8 hours | Core algorithm + caching |
| - chatService integration | 4-6 hours | Add compression step to RAG flow |
| - Environment config | 1 hour | .env + config files |
| - Chat route updates | 2 hours | Add ragCompress flag |
| - Logging & monitoring | 2-3 hours | Track compression metrics |
| - Edge case handling | 4-6 hours | Fallbacks, errors, empty chunks |
| - Prompt engineering | 5-8 hours | Iterate on extraction prompt |
| **Phase 2: Frontend** | 8-12 hours | UI controls + metrics display |
| - Compression checkbox | 2 hours | Add to RAG options |
| - JavaScript wiring | 2 hours | Send ragCompress flag |
| - localStorage persistence | 1 hour | Save user preference |
| - Metrics display | 3-4 hours | Show compression ratio |
| - Analytics dashboard | 2-3 hours | Optional compression stats |
| **Phase 3: Testing** | 8-12 hours | Quality assurance |
| - Unit tests | 4 hours | 5+ test cases |
| - Integration tests | 4 hours | 3+ end-to-end tests |
| - Performance benchmarking | 2-4 hours | Measure time/token savings |
| - Manual quality review | 2-4 hours | Verify accuracy |
| **TOTAL** | **40-56 hours** | 3-5 days full-time |

---

## Expected Impact

### Token Savings

**Before Compression:**
- Query: "How does RAG work?"
- 5 chunks retrieved × 500 tokens each = 2,500 tokens
- Cost: $0.25 per query (example pricing)

**After Compression:**
- 5 chunks compressed to 200 tokens each = 1,000 tokens
- Compression overhead: +200 tokens
- Total: 1,200 tokens
- Cost: $0.12 per query
- **Savings: 52% ($0.13 per query)**

### Response Quality

**Expected:** No loss in quality (same accuracy)
**Reason:** Compression removes irrelevant sentences, not relevant information

### Latency Impact

**Compression Time:** +300-700ms
**But:** Faster LLM processing due to shorter context (-200-400ms)
**Net Impact:** +100-300ms (acceptable for 52% cost savings)

---

## Success Indicators

**Before:**
- Full chunks injected into prompts (2,000-3,000 tokens typical)
- High token costs
- Context contains 40-60% irrelevant information
- Potential response quality dilution

**After:**
- Compressed chunks injected (800-1,200 tokens typical)
- 40-60% lower token costs
- Context contains 90-95% relevant information
- Same or better response quality
- User can see compression ratio per source

**User Value:**
- **Cost Savings:** 40-60% reduction in token usage
- **Quality:** More focused, relevant context
- **Transparency:** Compression metrics visible in UI
- **Control:** Optional feature, can enable/disable

---

**Ready to implement!** This feature delivers significant cost savings and quality improvements while maintaining transparency through the existing citation system.
