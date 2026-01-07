# External Agent Task: RAG Advanced Features UI

## Context

The RAG system has **advanced features already fully implemented** in the backend (`/src/services/ragStore.js` - 647 lines) but they are NOT exposed in the chat UI. Users currently cannot access query expansion, hybrid search, or re-ranking features.

**Backend Features Ready**:
- ✅ Query expansion (generates multiple search variations)
- ✅ Hybrid search (combines vector + keyword search with RRF)
- ✅ Re-ranking (LLM-based relevance scoring)

**Problem**: Chat UI (`/public/index.html`) only uses basic vector search with default settings.

## Your Task: Expose RAG Features in Chat UI

Add UI controls to enable/disable advanced RAG features and pass parameters to the backend.

---

## Requirements

### 1. Add RAG Options Panel in Chat UI

**File**: `/public/index.html`

Find the chat interface section (around the model selector) and add:

```html
<!-- RAG Advanced Options (Collapsible Panel) -->
<div class="rag-options-panel" id="ragOptionsPanel" style="display: none;">
    <div class="panel-header" onclick="toggleRagOptions()">
        <h3>RAG Advanced Options</h3>
        <i class="fas fa-chevron-down" id="ragChevron"></i>
    </div>

    <div class="panel-content" id="ragOptionsContent" style="display: none;">
        <div class="option-row">
            <label class="toggle-label">
                <input type="checkbox" id="useRag" checked>
                <span>Enable RAG (Retrieval-Augmented Generation)</span>
            </label>
            <p class="option-help">Use semantic search to inject relevant context</p>
        </div>

        <div class="option-row" id="ragAdvancedOptions">
            <label class="toggle-label">
                <input type="checkbox" id="expandQuery">
                <span>Query Expansion</span>
            </label>
            <p class="option-help">Generate multiple search variations (+300ms latency)</p>
        </div>

        <div class="option-row" id="ragHybridOption">
            <label class="toggle-label">
                <input type="checkbox" id="hybridSearch">
                <span>Hybrid Search</span>
            </label>
            <p class="option-help">Combine vector + keyword search (+75ms latency)</p>
        </div>

        <div class="option-row" id="ragRerankOption">
            <label class="toggle-label">
                <input type="checkbox" id="rerankResults">
                <span>Re-ranking</span>
            </label>
            <p class="option-help">LLM-based relevance scoring (+1000ms latency)</p>
        </div>

        <div class="option-row">
            <label class="slider-label">
                <span>Top K Results: <span id="topKValue">5</span></span>
                <input type="range" id="topK" min="1" max="20" value="5"
                       oninput="document.getElementById('topKValue').textContent = this.value">
            </label>
            <p class="option-help">Number of context chunks to retrieve (1-20)</p>
        </div>
    </div>
</div>
```

### 2. Add Toggle Logic in JavaScript

**File**: `/public/js/chat.js` (or wherever chat logic lives)

Add functions:

```javascript
// Toggle RAG options panel
function toggleRagOptions() {
    const content = document.getElementById('ragOptionsContent');
    const chevron = document.getElementById('ragChevron');
    const isOpen = content.style.display === 'block';

    content.style.display = isOpen ? 'none' : 'block';
    chevron.className = isOpen ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
}

// Show/hide RAG panel based on useRag checkbox
document.getElementById('useRag')?.addEventListener('change', function(e) {
    const advancedOptions = document.getElementById('ragAdvancedOptions');
    const hybridOption = document.getElementById('ragHybridOption');
    const rerankOption = document.getElementById('ragRerankOption');

    if (advancedOptions) advancedOptions.style.display = e.target.checked ? 'block' : 'none';
    if (hybridOption) hybridOption.style.display = e.target.checked ? 'block' : 'none';
    if (rerankOption) rerankOption.style.display = e.target.checked ? 'block' : 'none';
});

// Get RAG options from UI
function getRagOptions() {
    const useRag = document.getElementById('useRag')?.checked;

    if (!useRag) {
        return { useRag: false };
    }

    return {
        useRag: true,
        expandQuery: document.getElementById('expandQuery')?.checked || false,
        hybridSearch: document.getElementById('hybridSearch')?.checked || false,
        rerankResults: document.getElementById('rerankResults')?.checked || false,
        topK: parseInt(document.getElementById('topK')?.value || '5')
    };
}
```

### 3. Modify Chat Request to Include RAG Options

**File**: `/public/js/chat.js` (in the sendMessage function)

Find where the chat API request is made (likely `POST /api/chat`) and modify:

```javascript
async function sendMessage() {
    const userMessage = messageInput.value.trim();
    if (!userMessage) return;

    // Get selected model
    const model = document.getElementById('modelSelect')?.value || 'qwen2.5-7b-instruct-q4_0';

    // Get RAG options from UI
    const ragOptions = getRagOptions();

    // Build request payload
    const payload = {
        message: userMessage,
        model: model,
        conversationId: currentConversationId || undefined,

        // Add RAG options
        useRag: ragOptions.useRag,
        ragOptions: {
            expandQuery: ragOptions.expandQuery,
            hybridSearch: ragOptions.hybridSearch,
            rerankResults: ragOptions.rerankResults,
            topK: ragOptions.topK
        }
    };

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        // Handle response...
    } catch (error) {
        console.error('Chat error:', error);
    }
}
```

### 4. Verify Backend Support

**File**: `/src/services/chatService.js`

The backend should already support these parameters. Verify the `chat()` function accepts:

```javascript
async function chat({
    message,
    model,
    conversationId,
    useRag = false,
    ragOptions = {}
}) {
    // ...

    if (useRag) {
        const searchOptions = {
            topK: ragOptions.topK || 5,
            expandQuery: ragOptions.expandQuery || false,
            hybridSearch: ragOptions.hybridSearch || false,
            rerankResults: ragOptions.rerankResults || false
        };

        const ragResults = await ragStore.search(message, searchOptions);
        // Inject into system prompt...
    }

    // ...
}
```

**If not present**: Add the ragOptions parameter handling to chatService.js.

### 5. Add CSS Styling

**File**: `/public/styles.css` (or inline in index.html)

```css
.rag-options-panel {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 16px;
}

.panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    user-select: none;
}

.panel-header h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    margin: 0;
}

.panel-header i {
    color: var(--muted);
    transition: transform 0.3s;
}

.panel-content {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--panel-border);
}

.option-row {
    margin-bottom: 16px;
}

.toggle-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
}

.toggle-label input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
}

.option-help {
    font-size: 12px;
    color: var(--muted);
    margin: 4px 0 0 28px;
}

.slider-label {
    display: block;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 8px;
}

.slider-label input[type="range"] {
    width: 100%;
    margin-top: 8px;
}

/* Show panel only when RAG is available */
.rag-options-panel.hidden {
    display: none;
}
```

### 6. Add Feature Detection

**File**: `/public/js/chat.js`

On page load, check if RAG is available:

```javascript
async function checkRagAvailability() {
    try {
        const response = await fetch('/api/rag/stats', { credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            if (data.status === 'success' && data.data.totalDocuments > 0) {
                // RAG has documents, show panel
                document.getElementById('ragOptionsPanel').style.display = 'block';
            } else {
                // No documents, hide panel
                document.getElementById('ragOptionsPanel').style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Failed to check RAG availability:', error);
        // Hide panel on error
        document.getElementById('ragOptionsPanel').style.display = 'none';
    }
}

// Call on page load
document.addEventListener('DOMContentLoaded', checkRagAvailability);
```

---

## Testing Checklist

### Manual Testing

**Setup**:
1. Ensure RAG documents are ingested (at least 1 document)
2. Open chat interface
3. RAG options panel should appear

**Test Cases**:
- [ ] RAG panel appears when documents exist
- [ ] RAG panel collapses/expands on header click
- [ ] Disabling "Enable RAG" hides advanced options
- [ ] Enabling "Enable RAG" shows advanced options
- [ ] Query expansion checkbox toggles
- [ ] Hybrid search checkbox toggles
- [ ] Re-ranking checkbox toggles
- [ ] Top K slider updates value display
- [ ] Chat request includes RAG options in payload
- [ ] Backend receives and uses RAG options
- [ ] Advanced features actually work (compare results)

**Verification**:
```javascript
// In browser console during chat:
// Check network tab -> POST /api/chat -> Request Payload
// Should see:
{
    "message": "test query",
    "model": "...",
    "useRag": true,
    "ragOptions": {
        "expandQuery": true,
        "hybridSearch": false,
        "rerankResults": false,
        "topK": 5
    }
}
```

### Backend Verification

**Test Backend Directly**:
```bash
curl -X POST http://localhost:3080/api/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: agentx.sid=..." \
  -d '{
    "message": "What is AgentX?",
    "model": "qwen2.5-7b-instruct-q4_0",
    "useRag": true,
    "ragOptions": {
        "expandQuery": true,
        "hybridSearch": true,
        "rerankResults": false,
        "topK": 10
    }
  }'
```

**Check logs** for:
```
[INFO] RAG search with options: { topK: 10, expandQuery: true, hybridSearch: true, rerankResults: false }
```

---

## Files to Modify

**Frontend**:
1. `/public/index.html` - Add RAG options panel HTML
2. `/public/js/chat.js` - Add toggle logic and modify sendMessage()
3. `/public/styles.css` - Add panel styling

**Backend** (if needed):
4. `/src/services/chatService.js` - Verify ragOptions handling
5. `/routes/chat.js` - Verify route accepts ragOptions parameter

---

## Expected Behavior After Implementation

### User Workflow
1. User opens chat interface
2. Sees "RAG Advanced Options" panel (if documents exist)
3. Clicks panel header to expand options
4. Enables "Query Expansion" checkbox
5. Sends message: "What is the architecture?"
6. Backend uses query expansion to search with variations
7. User sees improved RAG context in response

### Performance Impact Display (Optional)
Add a performance indicator:
```html
<div class="rag-stats" id="ragStats" style="display: none;">
    <small>RAG: Retrieved <span id="ragChunks">0</span> chunks in <span id="ragLatency">0</span>ms</small>
</div>
```

Update after each response:
```javascript
if (data.ragStats) {
    document.getElementById('ragChunks').textContent = data.ragStats.chunks;
    document.getElementById('ragLatency').textContent = data.ragStats.latency;
    document.getElementById('ragStats').style.display = 'block';
}
```

---

## Documentation

Create `/docs/features/RAG_UI_GUIDE.md`:

```markdown
# RAG Advanced Features UI Guide

## Overview
The chat interface exposes advanced RAG features for power users.

## Features

### Query Expansion
Generates multiple search query variations to improve recall.
- **Latency**: +300ms
- **Use when**: Queries with ambiguous or multiple meanings

### Hybrid Search
Combines vector similarity with BM25 keyword search using RRF.
- **Latency**: +75ms
- **Use when**: Queries with specific technical terms

### Re-ranking
Uses LLM to score and re-order search results by relevance.
- **Latency**: +1000ms
- **Use when**: Maximum precision required

### Top K
Number of context chunks to inject into prompt.
- **Range**: 1-20
- **Default**: 5
- **Tip**: Higher = more context but longer prompts

## Best Practices

**For General Queries**: Use defaults (no advanced features)
**For Technical Queries**: Enable Hybrid Search
**For Ambiguous Queries**: Enable Query Expansion
**For Critical Accuracy**: Enable Re-ranking (slow but precise)
```

---

## Success Criteria

- [ ] RAG options panel renders correctly
- [ ] All checkboxes and sliders work
- [ ] API requests include ragOptions
- [ ] Backend uses advanced features when enabled
- [ ] Performance indicators show latency impact
- [ ] Documentation created
- [ ] No breaking changes to existing chat flow

---

## Estimated Effort

**Time**: 2-3 hours
**Complexity**: Medium
**Priority**: High (exposes existing backend functionality)

---

## When Complete

Report back with:
1. Screenshot of RAG options panel (collapsed + expanded)
2. Screenshot of chat with advanced features enabled
3. Network tab screenshot showing ragOptions in payload
4. Console logs showing backend using advanced features
5. Any issues encountered or suggestions

Good luck! 🚀
