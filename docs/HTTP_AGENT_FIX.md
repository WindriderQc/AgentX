# HTTP Agent Configuration Fix

## Problem

After switching the secondary Ollama host from Windows to Linux, benchmark tests were experiencing:
- Network timeouts at 60 seconds (especially for gemma3:12b-it-qat)
- First test of every model failing
- Slow performance overall

Error example:
```
Error (60.0s)
gemma3:12b-it-qat → 6959e398dc90aaf5c7709981
network timeout at: http://192.168.2.111:11434/api/generate
```

## Root Cause

1. **Model Loading Time**: First request to a model can take 60-120 seconds as the model loads into GPU memory
2. **Connection Pooling Issues**: `node-fetch` v2 uses default HTTP agent with connection pooling, but:
   - No explicit keep-alive configuration
   - Stale connections weren't being detected/closed properly
   - Linux handles TCP keep-alive differently than Windows
3. **Timeout Too Short**: 60-second timeout was insufficient for model loading

## Solution

### 1. Created HTTP Agent Helper (`src/helpers/httpAgent.js`)

Centralized HTTP/HTTPS agent configuration with:

```javascript
const AGENT_CONFIG = {
    keepAlive: true,                // Enable connection reuse
    keepAliveMsecs: 1000,          // 1s interval (aggressive, prevents staleness)
    maxSockets: 10,                // Max concurrent connections per host
    maxFreeSockets: 2,             // Max idle connections (prevent accumulation)
    timeout: 60000,                // Socket establishment timeout
    scheduling: 'lifo'             // Last-In-First-Out (prefer newer connections)
};
```

**Key Design Decisions**:
- **Lower keepAliveMsecs (1s)**: More aggressive than default, prevents stale connections on Linux
- **Lower maxFreeSockets (2)**: Prevents accumulation of idle connections that might become stale
- **LIFO scheduling**: Prefers newer connections over older ones, reducing stale connection usage

### 2. Updated All Ollama API Calls

Modified all `fetch()` calls to Ollama API endpoints to use the configured agent:

**Before**:
```javascript
const response = await fetch(`${hostUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    timeout: 60000
});
```

**After**:
```javascript
const url = `${hostUrl}/api/generate`;
const fetchOptions = getFetchOptions(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    timeout: 120000  // Increased to 120s for model loading
});
const response = await fetch(url, fetchOptions);
```

### 3. Files Modified

1. **`src/helpers/httpAgent.js`** - NEW
   - Centralized HTTP agent configuration
   - `getAgent(url)` - Returns appropriate agent for URL
   - `getFetchOptions(url, options)` - Merges options with agent

2. **`src/services/benchmarkService.js`**
   - Updated `warmupModel()` - 120s timeout
   - Updated main test execution - 120s timeout
   - Updated `runTest()` - 120s timeout

3. **`src/services/qualityScorer.js`**
   - Updated `callJudge()` to use HTTP agent

4. **`src/services/modelRouter.js`**
   - Updated `getModelHealth()` to use HTTP agent
   - Updated classification calls to use HTTP agent

5. **`src/services/ragCompression.js`**
   - Updated compression LLM calls to use HTTP agent

6. **`routes/models-unified.js`**
   - Updated model unload endpoint to use HTTP agent

## Testing

Verified changes with:
```bash
# Syntax check
node -c src/helpers/httpAgent.js
node -c src/services/benchmarkService.js
# ... etc

# Module functionality test
node -e "const { httpAgent, getAgent, getFetchOptions } = require('./src/helpers/httpAgent'); ..."

# Service import test
node -e "require('./src/services/benchmarkService'); ..."
```

All tests passed ✓

## Expected Results

- ✅ No more 60-second timeout errors on first model request
- ✅ Models load successfully (even 60-120s load times)
- ✅ Consistent behavior across Windows and Linux hosts
- ✅ Better connection pooling and reuse
- ✅ No stale connection failures
- ✅ Faster subsequent requests (connection reuse)

## Configuration

The HTTP agent is automatically applied to all Ollama API calls. No configuration changes needed.

If you need to tune the agent behavior, edit `src/helpers/httpAgent.js`:
- `keepAliveMsecs`: Lower = more aggressive stale connection prevention
- `maxFreeSockets`: Lower = fewer idle connections kept
- `timeout`: Time to wait for socket establishment (not request completion)

## Notes

- **First request slowness is normal**: Models loading into GPU memory can take 60-120 seconds
- **Warmup helps**: The warmup call preloads models, making subsequent tests faster
- **LIFO scheduling**: Helps avoid stale connections by preferring recently created ones
- **Platform differences**: Linux is more strict about idle connections than Windows
