# Memory Optimization Guide for AgentX

## Current Situation
AgentX is running at ~93% heap usage (37.92 MB / 40.67 MB). This is close to the default Node.js heap limit.

## Solution Implemented

### 1. Increased Heap Size ✅
- **File**: `ecosystem.config.js`
- **Change**: Added `node_args: '--max-old-space-size=512'`
- **Effect**: Increases heap from ~40 MB to 512 MB
- **Action Required**: Restart PM2 to apply

```bash
# On the server
cd /home/yb/codes/AgentX
pm2 delete agentx
pm2 start ecosystem.config.js --only agentx
pm2 save
```

### 2. Additional Recommendations

#### A. Clear Embedding Cache Periodically
Add this to `server.js` or a separate cleanup script:

```javascript
// Clear old cache entries every 6 hours
setInterval(() => {
  const embeddingsService = require('./src/services/embeddings');
  const service = embeddingsService.getEmbeddingsService();
  const stats = service.getCacheStats();
  
  // If cache is large, reduce it
  if (stats.size > 500) {
    console.log('[Cleanup] Cache size:', stats.size, '- clearing old entries');
    // Implement cache eviction logic here
  }
}, 6 * 60 * 60 * 1000);
```

#### B. Monitor Memory Leaks
Check for common issues:
- Large conversation objects not being garbage collected
- Event listeners not being cleaned up
- Database cursors left open
- Response streams not being properly closed

#### C. Enable Automatic Restart on High Memory
Already configured in `ecosystem.config.js`:
```javascript
max_memory_restart: '500M'  // PM2 will restart if memory exceeds 500MB
```

#### D. Check for Memory Leaks
Run this on the server to identify leaks:

```bash
# Install heapdump
npm install heapdump

# Add to server.js temporarily
require('heapdump');

# Trigger heap dump via: kill -USR2 <pid>
# Analyze with Chrome DevTools
```

### 3. Quick Wins

#### Optimize Mongoose Queries
- Use `.lean()` on read-only queries (50% less memory)
- Limit result sets with `.limit()`
- Close cursors explicitly

```javascript
// Before
const conversations = await Conversation.find({ userId });

// After
const conversations = await Conversation.find({ userId })
  .select('title createdAt')
  .limit(100)
  .lean();
```

#### Clear Completed Promises
Ensure all promises are properly resolved/rejected to prevent hanging references.

## Monitoring

After restart, monitor memory with:
```bash
pm2 monit
# Or via API: GET /api/metrics/system
```

Expected new values:
- Heap Total: ~512 MB
- Heap Used: Should start low (~40 MB) and stabilize < 400 MB
- Warning threshold: 80% (409 MB)
- Critical threshold: 90% (460 MB)

## Next Steps

1. ✅ Deploy updated `ecosystem.config.js`
2. ⏳ Restart PM2 with new config
3. ⏳ Monitor for 24 hours
4. ⏳ If still high usage, implement cache cleanup
5. ⏳ Profile code to find memory leaks
