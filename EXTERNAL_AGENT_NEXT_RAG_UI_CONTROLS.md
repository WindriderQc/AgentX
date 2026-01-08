# External Agent Task: Expose RAG Advanced Options in Chat UI

**Date:** 2026-01-07
**Estimated Effort:** 4-6 hours
**Priority:** HIGH - Exposes existing backend features to users
**Agent Type:** UI Development

---

## Context

AgentX has three advanced RAG search features **fully implemented** in the backend but completely inaccessible from the UI:

1. **Query Expansion** - LLM generates related queries for better recall (+300ms)
2. **Hybrid Search** - Combines vector + keyword search using RRF algorithm (+75ms)
3. **Re-ranking** - LLM judges relevance for maximum precision (+1000ms)

**Current Problem:** Users can only enable/disable basic RAG. They cannot access these powerful features that dramatically improve search quality.

**Documentation Reference:** `/docs/features/RAG_SEARCH_FEATURES.md` (182 lines)

---

## Current Implementation (Backend)

### 1. RAG Store (`/src/services/ragStore.js:188-206`)

The `searchSimilarChunks()` method accepts these options:

```javascript
{
  topK: 5,
  minScore: 0.7,
  expandQuery: true,      // Enable query expansion
  rerankResults: true,    // Enable re-ranking
  hybridSearch: true      // Enable hybrid search
}
```

### 2. Chat Service (`/src/services/chatService.js:191-193`)

The `sendMessage()` function passes these options to RAG store:

```javascript
const searchResults = await ragStore.searchSimilarChunks(lastUserMessage, {
    topK: 5,
    minScore: 0.25,
    filters: ragFilters,
    ollamaHost,
    expandQuery: options?.ragExpand === true,    // ← NEEDS UI CONTROL
    rerankResults: options?.ragRerank === true,  // ← NEEDS UI CONTROL
    hybridSearch: options?.ragHybrid === true    // ← NEEDS UI CONTROL
});
```

**Key Finding:** The backend is ready. It just needs `ragExpand`, `ragRerank`, and `ragHybrid` passed from the frontend.

---

## Task: Add UI Controls to Chat Interface

### Files to Modify

1. **`/public/chat.html`** - Add RAG options panel
2. **`/public/js/chat.js`** - Wire up options to API calls

### Phase 1: Add UI Controls (2 hours)

**Location:** `/public/chat.html` - In the message composition area, below existing "Use RAG" checkbox

**Mockup:**
```html
<div class="rag-controls" id="ragControls" style="display: none;">
  <label class="rag-checkbox-wrapper">
    <input type="checkbox" id="useRAG" checked />
    <span>Use RAG (semantic search)</span>
  </label>

  <!-- NEW: Advanced RAG Options -->
  <div class="rag-advanced-options" style="margin-left: 24px; margin-top: 8px;">
    <label class="rag-checkbox-wrapper" title="LLM generates related queries for better recall">
      <input type="checkbox" id="ragExpand" />
      <span>Query Expansion <span class="latency-badge">+300ms</span></span>
      <i class="info-icon">ⓘ</i>
    </label>

    <label class="rag-checkbox-wrapper" title="Combines vector + keyword search using RRF">
      <input type="checkbox" id="ragHybrid" />
      <span>Hybrid Search <span class="latency-badge">+75ms</span></span>
      <i class="info-icon">ⓘ</i>
    </label>

    <label class="rag-checkbox-wrapper" title="LLM judges relevance for maximum precision">
      <input type="checkbox" id="ragRerank" />
      <span>Re-ranking <span class="latency-badge">+1000ms</span></span>
      <i class="info-icon">ⓘ</i>
    </label>
  </div>
</div>
```

**CSS Styling Requirements:**
```css
.rag-advanced-options {
  margin-left: 24px;
  margin-top: 8px;
  padding: 8px;
  background: rgba(102, 126, 234, 0.05);
  border-left: 2px solid rgba(102, 126, 234, 0.3);
  border-radius: 4px;
}

.rag-checkbox-wrapper {
  display: flex;
  align-items: center;
  margin: 4px 0;
  font-size: 14px;
}

.latency-badge {
  margin-left: 6px;
  padding: 2px 6px;
  background: rgba(255, 165, 0, 0.15);
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #ff8800;
}

.info-icon {
  margin-left: 6px;
  font-size: 12px;
  color: #667eea;
  cursor: help;
}
```

**Behavior:**
- Advanced options should be **disabled** when "Use RAG" is unchecked
- Advanced options should be **collapsed/hidden** by default, with a "Show Advanced" toggle
- Latency badges help users understand performance trade-offs

### Phase 2: Wire Up to JavaScript (1.5 hours)

**Location:** `/public/js/chat.js` - In the `sendMessage()` function

**Current RAG Integration (Lines ~200-250):**
```javascript
// Find the current RAG checkbox logic
const useRAG = document.getElementById('useRAG')?.checked;

// Add to the fetch body:
const body = {
  message: userMessage,
  model: currentModel,
  useRAG: useRAG,
  // ... other options
};
```

**NEW: Add Advanced Options:**
```javascript
const useRAG = document.getElementById('useRAG')?.checked;
const ragExpand = document.getElementById('ragExpand')?.checked;
const ragHybrid = document.getElementById('ragHybrid')?.checked;
const ragRerank = document.getElementById('ragRerank')?.checked;

const body = {
  message: userMessage,
  model: currentModel,
  useRAG: useRAG,
  ragExpand: useRAG && ragExpand,   // Only send if RAG is enabled
  ragRerank: useRAG && ragRerank,   // Only send if RAG is enabled
  ragHybrid: useRAG && ragHybrid,   // Only send if RAG is enabled
  // ... other options
};
```

**Backend Support (Already Exists):**
- Chat route (`/routes/chat.js:40-50`) already passes these options to chatService
- If not explicitly handled, add this logic:
  ```javascript
  const ragExpand = req.body.ragExpand === true;
  const ragRerank = req.body.ragRerank === true;
  const ragHybrid = req.body.ragHybrid === true;

  const response = await chatService.sendMessage({
    // ... other params,
    ragExpand,
    ragRerank,
    ragHybrid
  });
  ```

### Phase 3: Persistence (1 hour)

**Feature:** Remember user preferences across sessions

**Implementation:**
```javascript
// On page load - restore preferences
document.addEventListener('DOMContentLoaded', () => {
  const ragExpand = localStorage.getItem('rag_expand') === 'true';
  const ragHybrid = localStorage.getItem('rag_hybrid') === 'true';
  const ragRerank = localStorage.getItem('rag_rerank') === 'true';

  document.getElementById('ragExpand').checked = ragExpand;
  document.getElementById('ragHybrid').checked = ragHybrid;
  document.getElementById('ragRerank').checked = ragRerank;
});

// On checkbox change - persist preferences
document.getElementById('ragExpand').addEventListener('change', (e) => {
  localStorage.setItem('rag_expand', e.target.checked);
});

document.getElementById('ragHybrid').addEventListener('change', (e) => {
  localStorage.setItem('rag_hybrid', e.target.checked);
});

document.getElementById('ragRerank').addEventListener('change', (e) => {
  localStorage.setItem('rag_rerank', e.target.checked);
});
```

### Phase 4: Tooltips & Help Text (1 hour)

**Feature Descriptions (from documentation):**

| Feature | Tooltip Text |
|---------|--------------|
| **Query Expansion** | "LLM generates 2-3 related queries to improve recall. Example: 'API config' → ['API configuration', 'setting up API keys', 'API authentication']" |
| **Hybrid Search** | "Combines semantic (vector) + exact keyword matching using Reciprocal Rank Fusion (RRF). Best for queries with specific terms." |
| **Re-ranking** | "LLM judges each result's relevance (0-10 score) and re-sorts. Removes false positives at the cost of speed." |

**Implementation Option 1: CSS Tooltips**
```html
<span class="tooltip-wrapper">
  <i class="info-icon">ⓘ</i>
  <span class="tooltip-text">LLM generates 2-3 related queries...</span>
</span>
```

**Implementation Option 2: Bootstrap Popovers** (if Bootstrap is available)
```html
<i class="info-icon" data-bs-toggle="popover"
   data-bs-content="LLM generates 2-3 related queries...">ⓘ</i>
```

### Phase 5: Testing & Verification (0.5 hours)

**Manual Test Scenarios:**

1. **Baseline Test (No Advanced Options)**
   - Uncheck all advanced options
   - Send query: "What is RAG?"
   - Verify: Standard vector search response (fast, ~100ms)

2. **Query Expansion Test**
   - Check "Query Expansion" only
   - Send query: "API configuration"
   - Verify: Response includes results from related queries (+300ms)
   - Check browser Network tab: Request body includes `ragExpand: true`

3. **Hybrid Search Test**
   - Check "Hybrid Search" only
   - Send query with specific term: "embedding model nomic-embed-text"
   - Verify: Exact keyword matches ranked higher (+75ms)
   - Check browser Network tab: Request body includes `ragHybrid: true`

4. **Re-ranking Test**
   - Check "Re-ranking" only
   - Send query: "performance metrics"
   - Verify: Results are more relevant but slower (+1000ms)
   - Check browser Network tab: Request body includes `ragRerank: true`

5. **Combined Test (All Options)**
   - Check all three advanced options
   - Send query: "How do I configure alerts?"
   - Verify: Best quality results but slowest (+1400ms total)
   - Check browser Network tab: All three flags are `true`

6. **Persistence Test**
   - Check "Query Expansion" + "Hybrid Search"
   - Reload page (Ctrl+R)
   - Verify: Checkboxes remain checked

7. **Disabled State Test**
   - Uncheck "Use RAG"
   - Verify: All advanced options are disabled/grayed out
   - Send message
   - Verify: No RAG options sent to backend

---

## Success Criteria

✅ **UI Complete:**
- Three new checkboxes visible in chat interface
- Latency badges displayed next to each option
- Info icons with helpful tooltips
- "Show Advanced" toggle to collapse/expand options
- Visual feedback when options are enabled

✅ **Functionality:**
- Checkboxes send `ragExpand`, `ragRerank`, `ragHybrid` to backend
- Options only active when "Use RAG" is enabled
- Preferences persist across browser sessions (localStorage)

✅ **Backend Integration:**
- Chat route passes options to chatService
- chatService passes options to ragStore
- No errors in browser console or server logs

✅ **User Experience:**
- Clear tooltips explain each feature
- Latency warnings help users make informed choices
- Options disabled when RAG is off

✅ **Documentation:**
- Add section to `/docs/user-manual/README.md` explaining advanced RAG options
- Update inline help text in UI

---

## Implementation Tips

### 1. Find Existing RAG Checkbox Logic

**Search Pattern:**
```bash
grep -n "useRAG" /home/yb/codes/AgentX/public/js/chat.js
grep -n "id=\"useRAG\"" /home/yb/codes/AgentX/public/chat.html
```

This will show you where the existing RAG checkbox is implemented.

### 2. Chat Route Modification

**File:** `/routes/chat.js`

**Find the POST `/api/chat` endpoint** and verify it passes these options to chatService:
```javascript
// Extract from request body
const ragExpand = req.body.ragExpand === true;
const ragRerank = req.body.ragRerank === true;
const ragHybrid = req.body.ragHybrid === true;

// Pass to chatService.sendMessage() options object
const response = await chatService.sendMessage({
  // ... existing params
  ragExpand,
  ragRerank,
  ragHybrid
});
```

If the chat route doesn't extract these yet, add the extraction logic.

### 3. Conditional Rendering

**Pattern:** Advanced options should be disabled when RAG is off

```javascript
document.getElementById('useRAG').addEventListener('change', (e) => {
  const advancedOptions = document.querySelectorAll('#ragExpand, #ragHybrid, #ragRerank');
  advancedOptions.forEach(opt => {
    opt.disabled = !e.target.checked;
    if (!e.target.checked) {
      opt.checked = false; // Uncheck when RAG is disabled
    }
  });
});
```

### 4. Show/Hide Advanced Section (Optional Enhancement)

```javascript
// Add a toggle button
<button id="toggleAdvanced" class="btn-link">▼ Show Advanced</button>

// JavaScript toggle
document.getElementById('toggleAdvanced').addEventListener('click', () => {
  const advanced = document.querySelector('.rag-advanced-options');
  const isVisible = advanced.style.display !== 'none';
  advanced.style.display = isVisible ? 'none' : 'block';
  document.getElementById('toggleAdvanced').textContent =
    isVisible ? '▼ Show Advanced' : '▲ Hide Advanced';
});
```

---

## Performance Expectations

| Configuration | Total Latency | Use Case |
|--------------|---------------|----------|
| Standard RAG | ~100ms | General queries |
| + Query Expansion | ~400ms | Broad concept searches |
| + Hybrid Search | ~175ms | Queries with specific terms |
| + Re-ranking | ~1100ms | High-precision needs |
| All 3 Combined | ~1400ms | Maximum quality (slow) |

**Note:** Users should see latency badges and understand the trade-offs.

---

## Edge Cases to Handle

1. **RAG Disabled + Advanced Options Checked**
   - Solution: Ignore advanced options when `useRAG` is false
   - Implementation: `ragExpand: useRAG && ragExpand`

2. **Multiple Options Conflicting**
   - No conflicts - all options can be combined
   - Backend handles gracefully (hybrid search skips expansion/reranking)

3. **Backend Timeout**
   - Re-ranking can take >1s
   - Ensure chat route timeout is at least 30 seconds

4. **No Documents Ingested**
   - Advanced options have no effect if RAG returns 0 results
   - User sees "No relevant documents found" message

---

## Related Files (Read-Only Reference)

**Backend Implementation (DO NOT MODIFY):**
- `/src/services/ragStore.js:188-206` - Feature implementation
- `/src/services/chatService.js:191-193` - Option passing
- `/docs/features/RAG_SEARCH_FEATURES.md` - Full documentation

**Frontend Files (TO MODIFY):**
- `/public/chat.html` - Add UI controls
- `/public/js/chat.js` - Wire up options to API
- `/routes/chat.js` - Verify options are passed to backend

---

## Deliverables

1. **Modified Files:**
   - `/public/chat.html` - RAG advanced options UI
   - `/public/js/chat.js` - JavaScript integration
   - `/routes/chat.js` - Backend option extraction (if needed)

2. **Documentation:**
   - Update `/docs/user-manual/README.md` with section on advanced RAG options
   - Include screenshots or HTML mockups

3. **Testing Report:**
   - Document results of 7 test scenarios
   - Include screenshots of UI
   - Confirm latency measurements match expectations

---

## Questions for Primary Agent (If Needed)

- Are there any specific design patterns or component libraries used in chat.html?
- Should the advanced options be collapsed by default or always visible?
- Any accessibility requirements (ARIA labels, keyboard navigation)?

---

## Estimated Timeline

| Phase | Effort | Description |
|-------|--------|-------------|
| Phase 1 | 2 hours | Add UI controls + CSS styling |
| Phase 2 | 1.5 hours | Wire up JavaScript + API integration |
| Phase 3 | 1 hour | localStorage persistence |
| Phase 4 | 1 hour | Tooltips + help text |
| Phase 5 | 0.5 hours | Testing + verification |
| **TOTAL** | **6 hours** | End-to-end implementation |

---

## Success Indicators

**Before:**
- Users can only enable/disable basic RAG (checkbox)
- No access to query expansion, hybrid search, or re-ranking
- Zero configuration options for search quality vs speed trade-offs

**After:**
- Users can enable query expansion for better recall (+25% results)
- Users can enable hybrid search for exact keyword matching (+30% recall)
- Users can enable re-ranking for maximum precision (+20% precision)
- Preferences persist across sessions
- Clear UI feedback on latency impact

**User Value:**
- Power users can optimize search for their needs
- Quality-focused users can enable re-ranking
- Speed-focused users can use standard RAG
- Users understand performance trade-offs via latency badges

---

## Reference: Feature Behavior

### Query Expansion
```
User Query: "API configuration"

Backend:
1. LLM generates related queries: ["API configuration", "setting up API keys", "API authentication"]
2. Searches with all 3 queries in parallel
3. Deduplicates by chunk ID (keeps highest score)
4. Returns top 5 results

Impact: +25% recall, +300ms latency
```

### Hybrid Search
```
User Query: "embedding model nomic-embed-text"

Backend:
1. Vector search: Returns semantically similar chunks
2. Keyword search: Returns chunks with exact term matches
3. RRF merge: Combines results using Reciprocal Rank Fusion
   - RRF_score = 1 / (60 + rank)
4. Returns top 5 merged results

Impact: +30% recall, +15% precision, +75ms latency
```

### Re-ranking
```
User Query: "performance metrics"

Backend:
1. Vector search: Returns top 10 results (2x topK)
2. LLM judges each result: Scores 0-10 for relevance
3. Re-sorts by LLM score (not vector score)
4. Returns top 5 best results

Impact: +20% precision, +1000ms latency
```

---

**Ready to implement!** This task exposes powerful features that are already battle-tested in production. No backend changes required - purely UI work.
