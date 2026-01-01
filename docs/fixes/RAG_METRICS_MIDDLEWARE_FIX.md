# RAG Metrics Fix - Middleware Order Issue

## Problem

The `/api/rag/metrics` endpoint was returning HTML instead of JSON, causing the error:
```
Failed to fetch RAG metrics: SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```

## Root Cause

In `src/app.js`, the `express.static()` middleware was mounted **before** the API routes, causing Express to try to serve static files before checking API endpoints. This is a common Express.js pitfall.

**Incorrect Order:**
```javascript
app.use(express.static(path.join(__dirname, '..', 'public')));  // ❌ Too early!

// ... session setup ...

app.use('/api/rag', ragRoutes);  // Routes registered after static
app.use('/api/analytics', analyticsRoutes);
// ... other routes ...
```

## Solution

Moved all API routes **before** the static file middleware to ensure API endpoints are matched first:

**Correct Order:**
```javascript
// 1. Session setup
app.use(session(sessionOptions));
app.use(attachUser);
app.use(requestLogger);

// 2. API ROUTES (must come before static files)
app.use('/api/auth', authRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/metrics', metricsRoutes);
// ... all other API routes ...

// 3. STATIC FILES (comes after API routes)
app.use(express.static(path.join(__dirname, '..', 'public')));

// 4. HTML fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
```

## Changes Made

### File: `src/app.js`

1. **Removed** `express.static()` from line 57 (after mongo-sanitize)
2. **Added** clear comment sections for organization:
   - `API ROUTES (must come BEFORE static files)`
   - `STATIC FILES (must come AFTER API routes)`
3. **Moved** static middleware to after all API route registrations
4. Moved session setup before API routes (was already correct)

### File: `public/js/analytics.js`

Enhanced error handling:

1. **Content-Type check** in `fetchJSON()`:
   - Now verifies response is actually JSON before parsing
   - Provides clearer error messages with content preview

2. **Better error display** in `refreshRagMetrics()`:
   - Shows user-friendly error message in UI
   - Sets all metric fields to "Error" state
   - Logs detailed error to console

## Testing

### Before Fix
```bash
curl -v http://localhost:3080/api/rag/metrics
# Returns: Content-Type: text/html; charset=UTF-8
# Body: <!DOCTYPE html>...
```

### After Fix
```bash
curl http://localhost:3080/api/rag/metrics
# Returns: Content-Type: application/json
{
  "status": "success",
  "healthy": true,
  "stats": {
    "totalDocuments": 48,
    "totalChunks": 1000,
    "avgChunksPerDoc": "20.83",
    "sourceBreakdown": { ... }
  }
}
```

## Verification

1. **Server restart**: Required to apply middleware order change
2. **Endpoint test**: `curl http://localhost:3080/api/rag/metrics | jq .`
3. **Dashboard test**: Open `http://localhost:3080/analytics.html` and check RAG section loads

## Why This Matters

Express.js processes middleware in the order they're registered. When `express.static()` comes first:

1. Request comes in for `/api/rag/metrics`
2. Static middleware checks if `public/api/rag/metrics` file exists
3. If not found, it tries `public/api/rag/metrics.html` or `public/api/rag/metrics/index.html`
4. May return a 404 page or redirect, which is HTML
5. API routes never get a chance to handle the request

With correct order:
1. Request comes in for `/api/rag/metrics`
2. API routes are checked first
3. Match found, JSON response sent
4. Static middleware never invoked for API paths

## Best Practice

**Always register API routes before static file middleware in Express.js**

```javascript
// ✅ CORRECT
app.use('/api', apiRoutes);           // APIs first
app.use(express.static('public'));    // Static files second
app.get('*', fallbackHandler);        // Catch-all last

// ❌ WRONG
app.use(express.static('public'));    // Static first = bad
app.use('/api', apiRoutes);           // APIs can't be reached
```

## Related Issues Prevented

This fix also ensures:
- All other API endpoints work correctly
- No accidental HTML responses on API routes
- Better separation of concerns
- Clearer code organization

## Status

✅ **Fixed and Tested**
- Endpoint returns proper JSON
- Dashboard loads metrics successfully
- Error handling improved
- Code organization enhanced

## Files Modified

- ✅ `src/app.js` - Fixed middleware order
- ✅ `public/js/analytics.js` - Enhanced error handling
