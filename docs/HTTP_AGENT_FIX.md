# HTTP Agent Configuration Fix + Intelligent Model Load Detection

## Problem

After switching the secondary Ollama host from Windows to Linux, benchmark tests were experiencing:
- Network timeouts at 60 seconds (especially for gemma3:12b-it-qat)
- First test of every model failing
- Slow performance overall
- **Unpredictable behavior**: Different models take different times to load

Error example:
```
Error (60.0s)
gemma3:12b-it-qat → 6959e398dc90aaf5c7709981
network timeout at: http://192.168.2.111:11434/api/generate
```

## Root Cause

1. **Model Loading Time**: First request to a model can take 60-120+ seconds as the model loads into GPU memory
2. **Variable Load Times**: Different model sizes take different amounts of time (2B model: ~10s, 12B model: ~60s, 70B model: 120s+)
3. **Connection Pooling Issues**: `node-fetch` v2 uses default HTTP agent with connection pooling, but:
   - No explicit keep-alive configuration
   - Stale connections weren't being detected/closed properly
   - Linux handles TCP keep-alive differently than Windows
4. **Fixed Timeout Problem**: Using arbitrary timeout values (60s, 120s) is either:
   - Too short: Causes failures for large models
   - Too long: Wastes time for small models that load quickly

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

### 2. Intelligent Model Load Detection (`src/helpers/modelLoadWaiter.js`)

**NEW**: Instead of using fixed timeouts, the system now monitors nvidia-smi to detect when models are actually loaded.

**How it works:**
1. Trigger model load with a minimal inference request (don't wait for completion)
2. Poll nvidia-smi every 2 seconds to check VRAM usage
3. Detect when VRAM usage stabilizes (< 100 MiB change for 2 consecutive readings)
4. Report actual load time and VRAM usage
5. Gracefully fall back to timeout if VRAM monitoring unavailable (e.g., Windows)

```javascript
// Key function
async function waitForModelLoad(hostUrl, modelName, options = {}) {
    // maxWaitMs: 120000 (max 120s wait)
    // pollIntervalMs: 2000 (check every 2s)
    // stabilityChecks: 2 (need 2 stable readings)
    // Returns: { loaded: boolean, durationMs, vramUsedMiB, error }
}
```

**Benefits:**
- **Adaptive**: Works for any model size automatically
- **Fast**: Doesn't wait full timeout if model loads quickly
- **Reliable**: Detects actual readiness, not arbitrary time
- **Visible**: Logs actual load time and VRAM consumption
- **Robust**: Falls back to timeout if VRAM monitoring unavailable

**Example behavior:**
- Small model (2B): Detects load in ~10s, proceeds immediately
- Medium model (7B): Detects load in ~25s, proceeds immediately  
- Large model (12B): Detects load in ~60s, proceeds immediately
- Huge model (70B): May take full 120s, accurately detected

### 3. Updated All Ollama API Calls

Modified all `fetch()` calls to Ollama API endpoints to use the configured agent:

**Before**:
```javascript
const response = await fetch(`${hostUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    timeout: 60000  // Fixed timeout
});
```

**After (with intelligent loading)**:
```javascript
// 1. Trigger model load (don't wait)
const url = `${hostUrl}/api/generate`;
const fetchOptions = getFetchOptions(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: 'warmup', stream: false, options: { num_predict: 1 } }),
    timeout: 10000  // Just trigger, don't wait
});
fetch(url, fetchOptions).catch(() => {}); // Start loading

// 2. Monitor VRAM to detect when loaded
const loadResult = await waitForModelLoadWithFallback(hostUrl, model, {
    maxWaitMs: 120000,      // Max wait
    pollIntervalMs: 2000,   // Check every 2s
    stabilityChecks: 2,     // Need 2 stable readings
    fallbackTimeoutMs: 30000 // Fallback if VRAM unavailable
});

// 3. Model is ready, proceed with actual inference
```

### 4. Files Modified

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
- ✅ No more random timeouts (detects actual load state)
- ✅ **Faster test execution** (doesn't wait full timeout if model loads quickly)
  - 2B model: ~10s wait instead of 120s
  - 7B model: ~25s wait instead of 120s
  - 12B model: ~60s wait instead of 120s
- ✅ **Automatic adaptation** to any model size
- ✅ **Better visibility** into loading process (logs load time and VRAM)
- ✅ Consistent behavior across Windows (fallback) and Linux (VRAM monitoring)
- ✅ Better connection pooling and reuse
- ✅ No stale connection failures
- ✅ Faster subsequent requests (connection reuse)

## Configuration

### HTTP Agent Configuration

The HTTP agent is automatically applied to all Ollama API calls. No configuration changes needed.

If you need to tune the agent behavior, edit `src/helpers/httpAgent.js`:
- `keepAliveMsecs`: Lower = more aggressive stale connection prevention
- `maxFreeSockets`: Lower = fewer idle connections kept
- `timeout`: Time to wait for socket establishment (not request completion)

### Model Load Waiter Configuration

Edit `src/helpers/modelLoadWaiter.js` or pass options when calling:

```javascript
await waitForModelLoadWithFallback(hostUrl, model, {
    maxWaitMs: 120000,          // Max time to wait (default: 120s)
    pollIntervalMs: 2000,       // How often to check VRAM (default: 2s)
    stabilityChecks: 2,         // Stable readings needed (default: 2)
    fallbackTimeoutMs: 30000    // Fallback if VRAM unavailable (default: 30s)
});
```

**Tuning guidelines:**
- **Larger `pollIntervalMs`**: Less SSH overhead, but slower detection
- **More `stabilityChecks`**: More confident model is loaded, but slower
- **Longer `fallbackTimeoutMs`**: Better for slow Windows hosts without VRAM monitoring

### VRAM Monitoring Requirements

For intelligent load detection to work, you need:
1. **nvidia-smi** installed on Ollama host
2. **SSH access** configured (see `OLLAMA_SSH_USER`, `OLLAMA_SSH_KEY_PATH`)
3. **GPU access** for the SSH user

If unavailable, system gracefully falls back to fixed timeout.

To disable VRAM monitoring for specific hosts:
```bash
OLLAMA_SSH_DISABLED_HOSTS=192.168.2.12,192.168.2.111
```

## Testing & Validation

### Manual Test

```bash
# Start a benchmark test
curl -X POST http://localhost:3080/api/benchmark/batch \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma3:12b-it-qat",
    "host": "http://192.168.2.111:11434",
    "levels": [1],
    "quality_scoring": false
  }'

# Check logs for VRAM monitoring
tail -f logs/combined.log | grep -E "VRAM|Model load|warmed up"
```

**Expected log output:**
```
Starting model warmup { host: 'http://192.168.2.111:11434', model: 'gemma3:12b-it-qat' }
VRAM check { currentVramUsed: 2048, vramChange: 1024, stableCount: 0 }
VRAM check { currentVramUsed: 4096, vramChange: 2048, stableCount: 0 }
Model loading in progress { vramIncreaseMiB: 2048 }
VRAM check { currentVramUsed: 4774, vramChange: 678, stableCount: 0 }
VRAM check { currentVramUsed: 4780, vramChange: 6, stableCount: 1 }
VRAM check { currentVramUsed: 4774, vramChange: -6, stableCount: 2 }
Model load detected (VRAM stabilized) { durationMs: 58234, vramUsedMiB: 4774 }
Model warmed up successfully (VRAM-verified) { durationMs: 58234, vramUsedMiB: 4774 }
```

## Notes

- **First request may still be slow**: Models need to load into GPU, but now we detect when it's done
- **VRAM monitoring is optional**: System works without it, just uses fixed timeouts as fallback
- **SSH overhead is minimal**: 2-second poll interval means ~30 SSH calls for a 60s load
- **Warmup is essential**: Pre-loads models so subsequent tests are fast
- **LIFO scheduling**: Helps avoid stale connections by preferring recently created ones
- **Platform differences**: Linux is more strict about idle connections than Windows
- **Windows hosts**: Will use fallback timeout since nvidia-smi typically not accessible via SSH

## Troubleshooting

### "VRAM monitoring unavailable"

**Cause**: SSH or nvidia-smi not configured

**Solutions**:
1. Configure SSH: `OLLAMA_SSH_USER=youruser`, `OLLAMA_SSH_KEY_PATH=/path/to/key`
2. Add host to known_hosts: `ssh-keyscan -H 192.168.2.111 >> ~/.ssh/known_hosts`
3. Or disable for that host: `OLLAMA_SSH_DISABLED_HOSTS=192.168.2.111`

System will fall back to 30s timeout automatically.

### "Model load wait timed out"

**Cause**: Model taking longer than 120s to load, or VRAM not stabilizing

**Solutions**:
1. Increase `maxWaitMs` in `modelLoadWaiter.js`
2. Check if model is actually loading: `nvidia-smi` on host
3. Check Ollama logs on host
4. Verify sufficient VRAM available

### Still getting timeouts after warmup

**Cause**: Model unloaded between warmup and test (keep_alive expired)

**Solutions**:
1. Increase Ollama's `keep_alive` setting
2. Add delay between warmup and test
3. Check Ollama logs for model unload events
