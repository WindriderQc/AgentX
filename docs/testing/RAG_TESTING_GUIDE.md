# RAG Advanced Options - Testing Guide

## Quick Manual Test

### 1. Test Persistence (5 minutes)

1. Open AgentX chat interface (`http://localhost:3000`)
2. Enable RAG toggle (if not already enabled)
3. Open RAG advanced options panel (click "RAG Options ▼")
4. Check all three checkboxes:
   - ✅ Query Expansion
   - ✅ Hybrid Search
   - ✅ Re-ranking
5. Move topK slider to 10
6. **Reload the page** (F5 or Ctrl+R)
7. ✅ **Expected:** All checkboxes remain checked, slider shows 10

### 2. Test localStorage (2 minutes)

1. Open DevTools (F12)
2. Go to Application tab → Storage → localStorage
3. Find key: `agentx-settings`
4. Click to view value
5. ✅ **Expected:** JSON contains:
```json
{
  "ragExpand": true,
  "ragHybrid": true,
  "ragRerank": true,
  "ragTopK": 10
}
```

### 3. Test API Integration (3 minutes)

1. Enable RAG with all advanced options
2. Open DevTools → Network tab
3. Send a chat message: "Explain the architecture"
4. Find the `/chat` POST request
5. Click → Payload tab
6. ✅ **Expected:** Request body contains:
```json
{
  "ragExpand": true,
  "ragHybrid": true,
  "ragRerank": true,
  "ragTopK": 10
}
```

### 4. Test Backend Processing (5 minutes)

1. Enable server debug logs:
```bash
DEBUG=agentx:* npm start
```

2. Send message with RAG enabled + query expansion
3. ✅ **Expected:** Server logs show:
```
RAG search options: { expandQuery: true, rerankResults: false, hybridSearch: false, topK: 5 }
```

4. Enable hybrid search and re-ranking
5. Send another message
6. ✅ **Expected:** Logs show all three options as `true`

### 5. Test Performance Impact (10 minutes)

| Configuration | Expected Latency | Measure |
|--------------|------------------|---------|
| RAG only (no options) | Baseline | _____ ms |
| + Query Expansion | +300ms | _____ ms |
| + Hybrid Search | +75ms | _____ ms |
| + Re-ranking | +1000ms | _____ ms |
| All three enabled | +1375ms | _____ ms |

**How to measure:**
1. Network tab → Click request → Timing tab → "Waiting for server response"
2. Run 3 tests per configuration and average the results

### 6. Test Edge Cases (5 minutes)

| Test Case | Steps | Expected Result |
|-----------|-------|----------------|
| Disable RAG | Uncheck RAG toggle | Advanced options panel hidden |
| Clear storage | Run `localStorage.clear()` in console, reload | All options default to unchecked, topK = 5 |
| Invalid topK | Set slider to 0 or 100 | Should clamp to valid range (1-20) |
| Null elements | Check console for errors | No errors (null-safe checks) |

## Automated Test Script

```bash
# Test localStorage persistence
node test-rag-persistence.js

# Test API endpoint
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "test"}],
    "ragExpand": true,
    "ragHybrid": true,
    "ragRerank": true,
    "ragTopK": 10
  }'
```

## Verification Checklist

- [ ] Settings persist across page reloads
- [ ] localStorage contains all 4 RAG options
- [ ] API requests include RAG options in payload
- [ ] Backend receives and processes options
- [ ] Query expansion adds ~300ms latency
- [ ] Hybrid search adds ~75ms latency
- [ ] Re-ranking adds ~1000ms latency
- [ ] Checkboxes trigger auto-save (no "Save" button needed)
- [ ] No console errors with any combination of options
- [ ] topK slider value syncs with display value

## Common Issues & Solutions

### Issue: Options don't persist
**Solution:** Check browser localStorage is enabled (not in private mode)

### Issue: Options not sent to backend
**Solution:** Verify `getRagOptions()` is called before sending message

### Issue: Backend ignores options
**Solution:** Check `chatService.js` lines 191-193 and 527-530

### Issue: Performance slower than expected
**Solution:** Check RAG index size - larger index = slower search

### Issue: Re-ranking times out
**Solution:** Increase timeout in `ragStore.js` or disable re-ranking for large indexes

## Expected Behavior Summary

✅ **What Works:**
- Persistence: All 4 options save to localStorage automatically
- Restoration: Options restore on page load
- Integration: Backend receives and processes all options
- UI: Checkboxes and slider work seamlessly

🔄 **What Changed:**
- Added 4 properties to `persistSettings()`
- Added restore logic to `hydrateForm()`
- Added 3 event listeners for checkboxes

✅ **What Didn't Change:**
- Backend logic (already complete)
- UI structure (already complete)
- getRagOptions() function (already complete)

## Success Criteria

✅ Implementation is successful if:
1. Checked boxes remain checked after page reload
2. localStorage contains `ragExpand`, `ragHybrid`, `ragRerank`, `ragTopK`
3. Network tab shows options in POST payload
4. Server logs show options passed to `ragStore.searchSimilarChunks()`
5. No console errors in DevTools
6. Performance impact matches expected latency increases

## Next Steps After Testing

1. Monitor user adoption metrics
2. Analyze which options users enable most
3. Consider adding visual feedback (loading indicators)
4. Add tooltips explaining each option
5. Add analytics tracking for A/B testing
