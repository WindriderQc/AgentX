# External Agent Next Task: Feature Alignment Scanner Improvements (Phase 1)

## Context

You've successfully completed the Feature Alignment Dashboard! The scanner currently has a **60% false positive rate** on orphan endpoints (6 out of 10 were actually in use but scanner missed them).

**Current Problem:**
- Scanner detects `fetch('/api/endpoint')` patterns
- Misses `API.get('/api/endpoint')` wrapper patterns
- Misses HTML form actions (`<form action="/register">`)
- Misses authentication route patterns (`/login`, `/logout`, `/register`, `/me`)

**Goal:** Reduce false positive rate from 60% to <20% by improving detection patterns.

---

## Task: Implement Scanner Phase 1 Improvements

**File:** `/src/services/featureAlignmentScanner.js`

### Improvement 1: Detect API Helper Wrappers

**Current Pattern (lines ~200-220):**
```javascript
const fetchPattern = /fetch\(['"](\/[^'"]+)['"]/g;
```

**Enhanced Pattern:**
```javascript
// Match both direct fetch and API helper wrappers
const apiCallPatterns = [
  /fetch\(['"](\/[^'"]+)['"]/g,                    // fetch('/api/endpoint')
  /API\.(get|post|put|delete|patch)\(['"](\/[^'"]+)['"]/g,  // API.get('/api/endpoint')
  /axios\.(get|post|put|delete|patch)\(['"](\/[^'"]+)['"]/g, // axios.get('/api/endpoint')
  /\$\.(get|post|put|delete)\(['"](\/[^'"]+)['"]/g          // $.get('/api/endpoint') (jQuery)
];
```

**Implementation:**
```javascript
function scanJavaScriptForEndpoints(jsContent, filePath) {
  const endpoints = [];

  const patterns = [
    { regex: /fetch\(['"](\/[^'"]+)['"]/, type: 'fetch' },
    { regex: /API\.(get|post|put|delete|patch)\(['"](\/[^'"]+)['"]/, type: 'api-helper' },
    { regex: /axios\.(get|post|put|delete|patch)\(['"](\/[^'"]+)['"]/, type: 'axios' },
  ];

  patterns.forEach(({ regex, type }) => {
    const matches = jsContent.matchAll(new RegExp(regex.source, 'g'));
    for (const match of matches) {
      const endpoint = match[2] || match[1]; // Get captured group
      endpoints.push({
        path: endpoint,
        detectedBy: type,
        file: filePath,
        confidence: type === 'api-helper' ? 'high' : 'medium'
      });
    }
  });

  return endpoints;
}
```

---

### Improvement 2: Parse HTML Form Actions

**Add New Function:**
```javascript
function scanHTMLForFormActions(htmlContent, filePath) {
  const endpoints = [];

  const patterns = [
    /<form[^>]+action=["']([^"']+)["']/gi,  // Form actions
    /<a[^>]+href=["'](\/api\/[^"']+)["']/gi, // API links
  ];

  patterns.forEach(regex => {
    const matches = htmlContent.matchAll(regex);
    for (const match of matches) {
      const path = match[1];
      if (path && !path.startsWith('http') && !path.startsWith('#')) {
        endpoints.push({
          path: path,
          detectedBy: 'html-form',
          file: filePath,
          confidence: 'high'
        });
      }
    }
  });

  return endpoints;
}
```

**Integrate into Main Scan:**
```javascript
// In scanHTMLFiles function
htmlFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf-8');

  // Existing: Scan for frontend evidence
  // NEW: Also scan for form actions
  const formEndpoints = scanHTMLForFormActions(content, file);
  formEndpoints.forEach(ep => {
    // Mark endpoint as having frontend reference
    registerFrontendUsage(ep.path, file);
  });
});
```

---

### Improvement 3: Auth Route Pattern Recognition

**Add Whitelist for Common Routes:**
```javascript
const COMMON_AUTH_ROUTES = [
  '/register',
  '/login',
  '/logout',
  '/me',
  '/auth/callback',
  '/auth/verify'
];

function isKnownAuthRoute(endpoint) {
  return COMMON_AUTH_ROUTES.some(route => endpoint === route || endpoint.startsWith(route));
}

// In orphan endpoint detection
function categorizeOrphanEndpoint(endpoint, frontendRefs) {
  if (frontendRefs.length > 0) {
    return { status: 'false-positive', reason: 'has-frontend-refs' };
  }

  if (isKnownAuthRoute(endpoint.path)) {
    return { status: 'likely-used', reason: 'common-auth-pattern' };
  }

  if (endpoint.path.includes('/api/dashboard/')) {
    return { status: 'likely-used', reason: 'dashboard-api-pattern' };
  }

  return { status: 'orphan', reason: 'no-references-found' };
}
```

---

### Improvement 4: Confidence Scoring

**Add Confidence Levels to Evidence:**
```javascript
function calculateEndpointConfidence(endpoint, evidence) {
  let confidence = 0;

  // Frontend references
  const frontendRefs = evidence.filter(e => e.type === 'frontend');
  if (frontendRefs.length > 0) {
    confidence += 30 * Math.min(frontendRefs.length, 3); // Max 90 points
  }

  // Detection method
  const apiHelperRefs = evidence.filter(e => e.detectedBy === 'api-helper');
  if (apiHelperRefs.length > 0) {
    confidence += 20; // API helper is more reliable than regex
  }

  // HTML form actions (high confidence)
  const formRefs = evidence.filter(e => e.detectedBy === 'html-form');
  if (formRefs.length > 0) {
    confidence += 30;
  }

  // Auth pattern match
  if (isKnownAuthRoute(endpoint.path)) {
    confidence += 20;
  }

  return Math.min(confidence, 100);
}
```

---

### Improvement 5: Exclude Backup Directories

**Filter Files to Scan:**
```javascript
function shouldExcludeFile(filePath) {
  const excludePatterns = [
    '/backup/',
    '/backups/',
    '/.backup/',
    '/archive/',
    '/node_modules/',
    '/dist/',
    '/build/'
  ];

  return excludePatterns.some(pattern => filePath.includes(pattern));
}

// Apply to file scanning
const htmlFiles = glob.sync('public/**/*.html')
  .filter(f => !shouldExcludeFile(f));

const jsFiles = glob.sync('public/js/**/*.js')
  .filter(f => !shouldExcludeFile(f));
```

---

## Expected Improvements

**Before Phase 1:**
- 10 orphan endpoints reported
- 6 false positives (60% false positive rate)
- Missed: API.get() calls, form actions, auth routes

**After Phase 1:**
- ~3-4 orphan endpoints reported (reduced from 10)
- 0-1 false positives (<20% false positive rate)
- Detected: API helpers, forms, auth patterns
- Confidence scoring shows reliability

---

## Testing

### Test 1: API Helper Detection
```bash
# Add this to a test JS file
echo "API.get('/api/test-endpoint')" > /tmp/test.js

# Run scanner and check if it detects /api/test-endpoint
node scripts/feature-alignment-scan.js
grep "test-endpoint" reports/feature-alignment.json
```

Expected: Endpoint detected with `detectedBy: "api-helper"`

### Test 2: Form Action Detection
```bash
# Add this to a test HTML file
echo '<form action="/test-form-endpoint" method="POST">' > /tmp/test.html

# Run scanner
node scripts/feature-alignment-scan.js
grep "test-form-endpoint" reports/feature-alignment.json
```

Expected: Endpoint detected with `detectedBy: "html-form"`

### Test 3: False Positive Reduction
```bash
# Run scanner
node scripts/feature-alignment-scan.js

# Check orphan endpoints
cat reports/feature-alignment-actions.md | grep -A 5 "Orphan Endpoints"
```

Expected: Only 3-4 orphans, not 10

---

## Verification Checklist

- [ ] Scanner detects `API.get('/api/endpoint')` patterns
- [ ] Scanner detects `<form action="/endpoint">` patterns
- [ ] Auth routes (`/login`, `/register`, `/logout`, `/me`) marked as likely-used
- [ ] Backup directories excluded from scanning
- [ ] Confidence scores calculated for all endpoints
- [ ] False positive rate reduced to <20%
- [ ] `/api/feedback`, auth endpoints, dashboard endpoints no longer marked as orphans
- [ ] Report regenerated with improved accuracy

---

## Estimated Effort

- API helper pattern: 30 minutes
- Form action parsing: 30 minutes
- Auth route recognition: 15 minutes
- Confidence scoring: 45 minutes
- Testing and validation: 30 minutes

**Total:** 2.5-3 hours

---

**Success Criteria:**
✅ Scanner detects 95% of actual frontend usage
✅ False positive rate reduced from 60% to <20%
✅ Confidence scoring helps identify unreliable detections
✅ Report shows 3-4 genuine orphans, not 10 false positives

Ready to implement! This will make the Feature Alignment Dashboard much more accurate and trustworthy. 🎯
