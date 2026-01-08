# External Agent Task: RAG Citation Tracking & Source References

**Date:** 2026-01-07
**Estimated Effort:** 24-48 hours (1-2 days)
**Priority:** HIGH - Users can't currently verify which documents informed responses
**Agent Type:** Full-Stack (Backend + Frontend)

---

## Context

**Problem:** When AgentX uses RAG (Retrieval-Augmented Generation) to answer questions, users have no way to verify which document chunks were used. This creates trust issues and makes it impossible to trace information back to source documents.

**Solution:** Implement citation tracking that:
1. Tracks which chunks were used during response generation
2. Adds citation markers ([1], [2], etc.) in LLM responses
3. Displays source references below each response with metadata
4. Allows users to click through to view full source documents

**Documentation Reference:** `/docs/features/RAG_SEARCH_FEATURES.md` (lines 123-126)

---

## Current RAG Flow (Without Citations)

```
User Query → RAG Search → Retrieve Chunks → Inject into Prompt → LLM Response
                                ↓
                          (chunks discarded, no tracking)
```

**Result:** User sees response but has no idea which documents were used.

---

## Desired RAG Flow (With Citations)

```
User Query → RAG Search → Retrieve Chunks → Inject into Prompt → LLM Response
                                ↓                                      ↓
                          Track chunk IDs                    Parse citation markers
                                ↓                                      ↓
                          Store in conversation         Display source references below
                                                                       ↓
                                                         User clicks → View full document
```

**Result:** User sees response with inline citations and can verify sources.

---

## Phase 1: Backend - Track RAG Sources (12-16 hours)

### 1.1 Modify Conversation Schema (1 hour)

**File:** `/models/Conversation.js`

**Current Message Schema:**
```javascript
const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  feedback: { type: String, enum: ['positive', 'negative'], default: null },
  feedbackTimestamp: { type: Date, default: null }
});
```

**NEW: Add RAG Sources Field:**
```javascript
const MessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  feedback: { type: String, enum: ['positive', 'negative'], default: null },
  feedbackTimestamp: { type: Date, default: null },

  // NEW: RAG citation tracking
  ragSources: [{
    chunkId: { type: mongoose.Schema.Types.ObjectId, ref: 'RAGChunk' },
    score: { type: Number },  // Relevance score (0-1)
    excerpt: { type: String }, // First 200 chars of chunk
    metadata: {
      filename: String,
      source: String,
      tags: [String],
      timestamp: Date,
      pageNumber: Number,
      section: String
    }
  }]
});
```

**Key Design Decisions:**
- Store chunk ID for reference lookup
- Cache excerpt to avoid DB queries when displaying citations
- Include relevance score to show confidence
- Store metadata snapshot (filename, tags, etc.) for display

### 1.2 Modify ChatService to Track Sources (4-6 hours)

**File:** `/src/services/chatService.js`

**Current RAG Integration (Lines 188-220):**
```javascript
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

  if (searchResults.length > 0) {
    ragContext = searchResults
      .map((r, i) => `[Document ${i + 1}]\n${r.text}\n`)
      .join('\n');

    systemPrompt += `\n\nRelevant context:\n${ragContext}`;
  }
}
```

**NEW: Track Sources:**
```javascript
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

  let ragSources = [];  // NEW: Track sources

  if (searchResults.length > 0) {
    ragContext = searchResults
      .map((r, i) => {
        // NEW: Build citation prompt
        return `[Document ${i + 1}]\nSource: ${r.metadata?.filename || 'Unknown'}\n${r.text}\n`;
      })
      .join('\n');

    systemPrompt += `\n\nRelevant context:\n${ragContext}`;

    // NEW: Store source metadata for later
    ragSources = searchResults.map((r, i) => ({
      chunkId: r._id,
      score: r.score,
      excerpt: r.text.substring(0, 200) + (r.text.length > 200 ? '...' : ''),
      metadata: {
        filename: r.metadata?.filename || 'Unknown',
        source: r.metadata?.source || '',
        tags: r.metadata?.tags || [],
        timestamp: r.metadata?.timestamp || null,
        pageNumber: r.metadata?.pageNumber || null,
        section: r.metadata?.section || null
      }
    }));
  }
}

// Later when saving the assistant's response:
conversation.messages.push({
  role: 'assistant',
  content: assistantResponse,
  timestamp: new Date(),
  ragSources: ragSources  // NEW: Attach sources to message
});
```

**Key Changes:**
1. Build `ragSources` array from search results
2. Include chunk ID, score, excerpt, and metadata
3. Attach `ragSources` to assistant message when saving conversation

### 1.3 Update System Prompt for Citation Instructions (1 hour)

**Goal:** Instruct LLM to include citation markers when using RAG context

**Option 1: Explicit Citation Instructions (Recommended)**

Add to system prompt when RAG is active:

```javascript
if (useRAG && searchResults.length > 0) {
  systemPrompt += `\n\n## Citation Instructions

When answering using the provided documents, include citation markers in your response using this format:
- Use [1], [2], [3] to reference Document 1, Document 2, Document 3, etc.
- Place citations immediately after claims or facts from that document
- You can cite multiple sources for one claim: [1][2]

Example: "The system uses MongoDB for persistence [1] and Qdrant for vector storage [2]."

IMPORTANT: Only cite documents that you actually reference. Do not add citations if you don't use the document context.`;
}
```

**Option 2: Few-Shot Examples (Alternative)**

Include example Q&A with citations in system prompt:

```javascript
const citationExample = `
Q: How does the RAG system work?
A: The RAG system uses a two-stage process [1]. First, it retrieves relevant document chunks using vector similarity search [2]. Then, it injects these chunks into the LLM prompt to provide context [1]. The system supports query expansion and re-ranking for improved accuracy [3].

Q: What database is used?
A: The system uses MongoDB for structured data storage [1] and Qdrant as the vector database for semantic search [2].
`;

if (useRAG && searchResults.length > 0) {
  systemPrompt += `\n\n## Citation Examples\n${citationExample}\n\nFollow this citation format in your responses.`;
}
```

**Recommendation:** Start with Option 1 (explicit instructions), fall back to Option 2 if citation quality is low.

### 1.4 API Response - Include RAG Sources (2 hours)

**File:** `/routes/chat.js` (or wherever the chat POST endpoint is)

**Current Response:**
```javascript
res.json({
  status: 'success',
  data: {
    response: assistantMessage,
    conversationId: conversation._id,
    model: modelUsed
  }
});
```

**NEW: Include RAG Sources:**
```javascript
// Extract ragSources from the last assistant message
const lastMessage = conversation.messages[conversation.messages.length - 1];
const ragSources = lastMessage.ragSources || [];

res.json({
  status: 'success',
  data: {
    response: assistantMessage,
    conversationId: conversation._id,
    model: modelUsed,
    ragSources: ragSources  // NEW: Send sources to frontend
  }
});
```

**Format Example:**
```json
{
  "status": "success",
  "data": {
    "response": "The system uses MongoDB [1] and Qdrant [2] for storage.",
    "ragSources": [
      {
        "chunkId": "507f1f77bcf86cd799439011",
        "score": 0.89,
        "excerpt": "MongoDB is used for structured data persistence...",
        "metadata": {
          "filename": "ARCHITECTURE.md",
          "source": "docs/architecture",
          "tags": ["database", "mongodb"],
          "timestamp": "2026-01-01T00:00:00.000Z"
        }
      },
      {
        "chunkId": "507f1f77bcf86cd799439012",
        "score": 0.85,
        "excerpt": "Qdrant serves as the vector database...",
        "metadata": {
          "filename": "RAG_SYSTEM.md",
          "source": "docs/architecture",
          "tags": ["rag", "qdrant"]
        }
      }
    ]
  }
}
```

---

## Phase 2: Frontend - Display Citations (8-12 hours)

### 2.1 Parse Citation Markers (2 hours)

**File:** `/public/js/chat.js`

**Goal:** Detect [1], [2], [3] markers and convert them to interactive elements

**Implementation:**

```javascript
/**
 * Parse citation markers and convert to clickable elements
 * @param {string} text - Assistant response with citation markers
 * @param {Array} sources - RAG sources from API response
 * @returns {string} HTML with interactive citations
 */
function parseCitations(text, sources) {
  if (!sources || sources.length === 0) {
    return text;
  }

  // Replace [1], [2], etc. with styled citation links
  const citationPattern = /\[(\d+)\]/g;

  return text.replace(citationPattern, (match, num) => {
    const index = parseInt(num) - 1;
    if (index >= 0 && index < sources.length) {
      return `<sup class="citation-marker" data-citation="${index}" title="Click to view source">${match}</sup>`;
    }
    return match; // If citation doesn't match a source, leave as-is
  });
}
```

**CSS for Citation Markers:**
```css
.citation-marker {
  color: #667eea;
  cursor: pointer;
  font-weight: 600;
  padding: 0 2px;
  border-radius: 3px;
  transition: background-color 0.2s;
}

.citation-marker:hover {
  background-color: rgba(102, 126, 234, 0.1);
  text-decoration: underline;
}
```

### 2.2 Display Source References Below Response (4-5 hours)

**Goal:** Show a "Sources" section below each assistant message

**HTML Structure:**
```html
<div class="message assistant-message">
  <div class="message-content">
    The system uses MongoDB <sup class="citation-marker" data-citation="0">[1]</sup>
    and Qdrant <sup class="citation-marker" data-citation="1">[2]</sup> for storage.
  </div>

  <!-- NEW: Sources Section -->
  <div class="sources-section">
    <div class="sources-header">
      <i class="icon-book"></i>
      <span>Sources (2)</span>
      <button class="toggle-sources">▼</button>
    </div>

    <div class="sources-list">
      <div class="source-item" data-citation="0">
        <div class="source-number">[1]</div>
        <div class="source-details">
          <div class="source-title">ARCHITECTURE.md</div>
          <div class="source-excerpt">MongoDB is used for structured data persistence...</div>
          <div class="source-metadata">
            <span class="source-score">Relevance: 89%</span>
            <span class="source-tags">
              <span class="tag">database</span>
              <span class="tag">mongodb</span>
            </span>
          </div>
        </div>
        <button class="view-full-document" data-chunk-id="507f1f77bcf86cd799439011">
          View Full
        </button>
      </div>

      <div class="source-item" data-citation="1">
        <div class="source-number">[2]</div>
        <div class="source-details">
          <div class="source-title">RAG_SYSTEM.md</div>
          <div class="source-excerpt">Qdrant serves as the vector database...</div>
          <div class="source-metadata">
            <span class="source-score">Relevance: 85%</span>
            <span class="source-tags">
              <span class="tag">rag</span>
              <span class="tag">qdrant</span>
            </span>
          </div>
        </div>
        <button class="view-full-document" data-chunk-id="507f1f77bcf86cd799439012">
          View Full
        </button>
      </div>
    </div>
  </div>
</div>
```

**JavaScript to Build Sources Section:**
```javascript
function buildSourcesSection(sources) {
  if (!sources || sources.length === 0) return '';

  const sourceItems = sources.map((src, index) => {
    const score = Math.round(src.score * 100);
    const tags = src.metadata.tags?.map(tag =>
      `<span class="tag">${tag}</span>`
    ).join('') || '';

    return `
      <div class="source-item" data-citation="${index}">
        <div class="source-number">[${index + 1}]</div>
        <div class="source-details">
          <div class="source-title">${src.metadata.filename}</div>
          <div class="source-excerpt">${src.excerpt}</div>
          <div class="source-metadata">
            <span class="source-score">Relevance: ${score}%</span>
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

**CSS Styling:**
```css
.sources-section {
  margin-top: 12px;
  padding: 12px;
  background: rgba(102, 126, 234, 0.05);
  border-left: 3px solid #667eea;
  border-radius: 4px;
  font-size: 13px;
}

.sources-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #667eea;
  cursor: pointer;
  margin-bottom: 8px;
}

.toggle-sources {
  margin-left: auto;
  background: none;
  border: none;
  color: #667eea;
  cursor: pointer;
  font-size: 12px;
}

.sources-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-item {
  display: flex;
  gap: 10px;
  padding: 8px;
  background: white;
  border-radius: 4px;
  border: 1px solid #e0e0e0;
  align-items: flex-start;
}

.source-item.highlighted {
  border-color: #667eea;
  background: rgba(102, 126, 234, 0.05);
}

.source-number {
  font-weight: 700;
  color: #667eea;
  font-size: 14px;
  min-width: 30px;
}

.source-details {
  flex: 1;
}

.source-title {
  font-weight: 600;
  color: #333;
  margin-bottom: 4px;
}

.source-excerpt {
  color: #666;
  font-size: 12px;
  margin-bottom: 6px;
  line-height: 1.4;
}

.source-metadata {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.source-score {
  font-size: 11px;
  color: #888;
  font-weight: 500;
}

.source-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tag {
  padding: 2px 6px;
  background: rgba(102, 126, 234, 0.1);
  border-radius: 3px;
  font-size: 10px;
  color: #667eea;
  font-weight: 500;
}

.view-full-document {
  padding: 6px 12px;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background-color 0.2s;
}

.view-full-document:hover {
  background: #5568d3;
}
```

### 2.3 Interactive Citation Highlighting (2 hours)

**Goal:** Clicking a citation marker highlights the corresponding source

**Implementation:**
```javascript
// Click handler for citation markers
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('citation-marker')) {
    const citationIndex = e.target.dataset.citation;

    // Find the sources section in the same message
    const messageEl = e.target.closest('.assistant-message');
    const sourcesSection = messageEl.querySelector('.sources-section');

    if (sourcesSection) {
      // Expand sources if collapsed
      const sourcesList = sourcesSection.querySelector('.sources-list');
      if (sourcesList.style.display === 'none') {
        sourcesList.style.display = 'flex';
      }

      // Highlight the corresponding source
      const allSources = sourcesSection.querySelectorAll('.source-item');
      allSources.forEach(src => src.classList.remove('highlighted'));

      const targetSource = sourcesSection.querySelector(`[data-citation="${citationIndex}"]`);
      if (targetSource) {
        targetSource.classList.add('highlighted');
        targetSource.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }
});

// Toggle sources visibility
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('toggle-sources')) {
    const sourcesSection = e.target.closest('.sources-section');
    const sourcesList = sourcesSection.querySelector('.sources-list');
    const toggleBtn = e.target;

    if (sourcesList.style.display === 'none') {
      sourcesList.style.display = 'flex';
      toggleBtn.textContent = '▼';
    } else {
      sourcesList.style.display = 'none';
      toggleBtn.textContent = '▶';
    }
  }
});
```

### 2.4 View Full Document Modal (2-3 hours)

**Goal:** Allow users to click "View Full" to see the entire document chunk

**Option 1: Modal Dialog (Recommended)**

```javascript
// Click handler for "View Full" button
document.addEventListener('click', async (e) => {
  if (e.target.classList.contains('view-full-document')) {
    const chunkId = e.target.dataset.chunkId;

    try {
      // Fetch full chunk from API
      const response = await fetch(`/api/rag/chunks/${chunkId}`);
      const data = await response.json();

      if (data.status === 'success') {
        showDocumentModal(data.data);
      }
    } catch (error) {
      console.error('Failed to load document:', error);
      alert('Failed to load full document');
    }
  }
});

function showDocumentModal(chunk) {
  const modal = document.createElement('div');
  modal.className = 'document-modal-overlay';
  modal.innerHTML = `
    <div class="document-modal">
      <div class="modal-header">
        <h3>${chunk.metadata.filename}</h3>
        <button class="close-modal">&times;</button>
      </div>
      <div class="modal-metadata">
        <span>Source: ${chunk.metadata.source}</span>
        ${chunk.metadata.pageNumber ? `<span>Page: ${chunk.metadata.pageNumber}</span>` : ''}
        ${chunk.metadata.section ? `<span>Section: ${chunk.metadata.section}</span>` : ''}
      </div>
      <div class="modal-content">
        <pre>${chunk.text}</pre>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  modal.querySelector('.close-modal').addEventListener('click', () => {
    modal.remove();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}
```

**CSS for Modal:**
```css
.document-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.document-modal {
  background: white;
  border-radius: 8px;
  max-width: 800px;
  max-height: 80vh;
  width: 90%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px;
  border-bottom: 1px solid #e0e0e0;
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
}

.close-modal {
  background: none;
  border: none;
  font-size: 28px;
  cursor: pointer;
  color: #888;
  line-height: 1;
}

.close-modal:hover {
  color: #333;
}

.modal-metadata {
  padding: 12px 20px;
  background: #f5f5f5;
  font-size: 13px;
  color: #666;
  display: flex;
  gap: 20px;
}

.modal-content {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.modal-content pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.6;
  margin: 0;
}
```

**Backend API Endpoint (NEW):**

**File:** `/routes/rag.js` (or create if doesn't exist)

```javascript
// GET /api/rag/chunks/:chunkId - Retrieve full chunk by ID
router.get('/chunks/:chunkId', async (req, res) => {
  try {
    const { chunkId } = req.params;

    // Query RAG chunk from database (adjust based on your storage)
    const chunk = await RAGChunk.findById(chunkId);

    if (!chunk) {
      return res.status(404).json({
        status: 'error',
        message: 'Chunk not found'
      });
    }

    res.json({
      status: 'success',
      data: {
        _id: chunk._id,
        text: chunk.text,
        metadata: chunk.metadata
      }
    });
  } catch (error) {
    logger.error('Failed to fetch chunk', { error: error.message, chunkId: req.params.chunkId });
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});
```

---

## Phase 3: Testing & Refinement (4-8 hours)

### 3.1 Manual Testing Scenarios (2 hours)

**Test 1: Basic Citation Tracking**
1. Enable RAG
2. Ask: "What database does AgentX use?"
3. Verify:
   - Response includes [1] or [2] markers
   - Sources section appears below response
   - Citations are clickable and highlight correct source

**Test 2: Multiple Citations**
1. Ask: "How does the RAG system work?"
2. Verify:
   - Response includes multiple citations ([1][2][3])
   - All sources listed with correct metadata
   - Clicking each citation highlights correct source

**Test 3: No RAG (Baseline)**
1. Disable RAG
2. Ask any question
3. Verify:
   - No citation markers in response
   - No sources section displayed
   - Normal response formatting

**Test 4: View Full Document**
1. Enable RAG and ask question
2. Click "View Full" on any source
3. Verify:
   - Modal opens with full chunk text
   - Metadata displayed correctly
   - Close button works

**Test 5: Citation Highlighting**
1. Enable RAG and ask question with multiple citations
2. Click [1] marker
3. Verify:
   - Source 1 is highlighted
   - Scrolls to source if not visible
4. Click [2] marker
5. Verify:
   - Source 2 is highlighted
   - Source 1 unhighlighted

**Test 6: Toggle Sources Visibility**
1. Enable RAG and ask question
2. Click "▼" toggle button
3. Verify:
   - Sources list collapses
   - Button changes to "▶"
4. Click "▶" toggle button
5. Verify:
   - Sources list expands
   - Button changes to "▼"

**Test 7: Advanced RAG Options**
1. Enable Query Expansion + Re-ranking
2. Ask: "performance monitoring"
3. Verify:
   - Citations still work correctly
   - Source count matches advanced search results

### 3.2 Edge Cases (1 hour)

**Edge Case 1: LLM Doesn't Add Citations**
- **Problem:** LLM response has no [1] markers despite using RAG
- **Mitigation:**
  - Still show sources section (user can manually verify)
  - Add notice: "ℹ️ Sources were used but not explicitly cited"

**Edge Case 2: Invalid Citation Number**
- **Problem:** LLM writes [5] but only 3 sources exist
- **Mitigation:**
  - Leave [5] as plain text (don't convert to interactive element)
  - Log warning for monitoring

**Edge Case 3: No Sources Retrieved**
- **Problem:** RAG search returns 0 results
- **Solution:**
  - Don't show sources section
  - Response generated without RAG context

**Edge Case 4: Chunk Deleted**
- **Problem:** User clicks "View Full" but chunk was deleted
- **Solution:**
  - Show error message: "Source document no longer available"
  - Excerpt still visible in sources section

### 3.3 Performance Testing (1 hour)

**Metrics to Track:**
1. **Latency Impact:** Does storing ragSources slow down responses?
   - Target: <5ms overhead
2. **Database Size:** How much storage do ragSources add?
   - Estimate: ~500 bytes per source × 5 sources = 2.5KB per message
3. **Frontend Rendering:** Does large sources section slow down UI?
   - Test with 10+ sources

### 3.4 Citation Quality Testing (2-4 hours)

**Goal:** Verify LLM actually adds citations correctly

**Test Different Models:**
1. `llama3.1:8b` - Base model
2. `gemma2:9b` - Alternative model
3. `mistral:7b` - Another alternative

**Test Different Prompt Styles:**
1. Explicit instructions (Phase 1.3 Option 1)
2. Few-shot examples (Phase 1.3 Option 2)
3. Combined approach

**Success Criteria:**
- ≥70% of responses include citation markers when RAG is used
- Citations match actual document usage (manual verification)
- No hallucinated citations (referencing non-existent [10] when only 3 sources)

**If Citation Quality Is Low (<50%):**
- Refine system prompt instructions
- Add more explicit examples
- Consider post-processing (auto-add citations if LLM forgets)

---

## Success Criteria

✅ **Backend Complete:**
- Conversation schema includes `ragSources` field
- chatService tracks RAG sources and attaches to messages
- API response includes `ragSources` array
- New endpoint `/api/rag/chunks/:id` returns full chunk

✅ **Frontend Complete:**
- Citation markers ([1], [2]) are clickable and styled
- Sources section displayed below each RAG-enhanced response
- Clicking citation highlights corresponding source
- "View Full" button opens modal with complete document text
- Toggle button collapses/expands sources section

✅ **User Experience:**
- Users can verify which documents informed each response
- Citations are visually distinct and clickable
- Source metadata (filename, relevance, tags) is displayed
- Full document text is accessible on demand

✅ **Quality:**
- ≥70% of RAG responses include citation markers
- No hallucinated citations
- Performance overhead <5ms per message
- Works with all RAG advanced options (expansion, hybrid, re-ranking)

---

## Implementation Tips

### Tip 1: Start with Backend First

Complete Phase 1 (backend) entirely before starting Phase 2 (frontend). This allows you to:
- Test that sources are stored correctly in database
- Verify API response includes sources
- Use tools like Postman to inspect data structure

### Tip 2: Use Console Logging Extensively

Add debug logs to track sources:
```javascript
console.log('RAG search results:', searchResults.length);
console.log('Tracked sources:', ragSources);
console.log('API response ragSources:', response.data.ragSources);
```

### Tip 3: Test Without LLM Citations First

Before implementing citation marker parsing, test that sources section renders correctly:
```javascript
// Temporarily hardcode citation markers for testing
const mockResponse = "The system uses MongoDB [1] and Qdrant [2].";
```

### Tip 4: Graceful Degradation

Ensure system works even if:
- LLM doesn't add citations → Show sources anyway
- Chunk is deleted → Show error gracefully
- API call fails → Sources section just doesn't appear

---

## Optional Enhancements (If Time Permits)

### Enhancement 1: Export Citations (2 hours)

Add "Export as Bibliography" button:
```javascript
function exportCitations(sources) {
  const bibliography = sources.map((src, i) => {
    return `[${i + 1}] ${src.metadata.filename} - ${src.metadata.source}`;
  }).join('\n');

  // Copy to clipboard or download as .txt
  navigator.clipboard.writeText(bibliography);
  alert('Bibliography copied to clipboard');
}
```

### Enhancement 2: Source Filtering (2 hours)

Allow users to filter sources by relevance score or tags:
```html
<div class="sources-filters">
  <label>
    Min Relevance: <input type="range" min="0" max="100" value="0" id="minRelevance" />
  </label>
  <select id="tagFilter">
    <option value="">All Tags</option>
    <option value="database">Database</option>
    <option value="rag">RAG</option>
  </select>
</div>
```

### Enhancement 3: Inline Preview (3 hours)

Show excerpt on hover instead of requiring click:
```javascript
// Tooltip on citation hover
document.addEventListener('mouseenter', (e) => {
  if (e.target.classList.contains('citation-marker')) {
    const index = e.target.dataset.citation;
    const source = sources[index];

    showTooltip(e.target, source.excerpt);
  }
}, true);
```

---

## Deliverables

1. **Modified Backend Files:**
   - `/models/Conversation.js` - Added ragSources field
   - `/src/services/chatService.js` - Track and attach sources
   - `/routes/chat.js` - Include ragSources in API response
   - `/routes/rag.js` - New endpoint for fetching full chunks

2. **Modified Frontend Files:**
   - `/public/js/chat.js` - Citation parsing, source rendering, interactions
   - `/public/css/chat.css` (or equivalent) - Citation styling

3. **Documentation:**
   - Implementation guide with examples
   - Testing checklist (7 scenarios)
   - Edge case handling documentation

4. **Testing Report:**
   - Manual test results (7 scenarios)
   - Citation quality metrics (% of responses with citations)
   - Performance impact measurements

---

## Questions for Primary Agent (If Needed)

- What is the exact schema for RAG chunks? (Need field names for metadata)
- Is there an existing RAG routes file, or should I create `/routes/rag.js`?
- What CSS framework is used (Bootstrap, Tailwind, custom)?
- Are there existing modal components to reuse?
- Should citations be stored permanently or regenerated on conversation load?

---

## Estimated Timeline

| Phase | Effort | Description |
|-------|--------|-------------|
| **Phase 1: Backend** | 12-16 hours | Track sources, modify schema, update prompts |
| - Schema modifications | 1 hour | Add ragSources field |
| - ChatService tracking | 4-6 hours | Capture and store sources |
| - System prompt updates | 1 hour | Citation instructions |
| - API response | 2 hours | Include sources in response |
| - Full chunk endpoint | 2-3 hours | GET /api/rag/chunks/:id |
| - Testing & debugging | 2-4 hours | Backend validation |
| **Phase 2: Frontend** | 8-12 hours | Display and interact with citations |
| - Citation parsing | 2 hours | Convert [1] to interactive elements |
| - Sources section UI | 4-5 hours | Build and style sources list |
| - Interactive highlighting | 2 hours | Click handlers |
| - View full modal | 2-3 hours | Modal dialog + API call |
| - CSS refinements | 2 hours | Polish and responsive design |
| **Phase 3: Testing** | 4-8 hours | Quality assurance |
| - Manual testing | 2 hours | 7 test scenarios |
| - Edge cases | 1 hour | Handle failures gracefully |
| - Performance | 1 hour | Measure overhead |
| - Citation quality | 2-4 hours | Test prompt variations |
| **TOTAL** | **24-36 hours** | 1-2 days full-time |

---

## Success Indicators

**Before:**
- Users see RAG-enhanced responses but have no idea which documents were used
- No way to verify information or trace back to sources
- Trust issues with RAG-generated content

**After:**
- Every RAG response includes clickable citations
- Source documents listed with metadata (filename, relevance, tags)
- Users can click "View Full" to see complete document text
- Citation markers link directly to corresponding sources
- Users can verify and trust RAG-generated information

**User Value:**
- **Transparency:** See exactly which documents informed each response
- **Verification:** Click through to verify claims against source documents
- **Trust:** Confidence that information is grounded in actual documentation
- **Discovery:** Find related documents through citation browsing

---

**Ready to implement!** This feature transforms RAG from a "black box" to a transparent, verifiable system that users can trust.
