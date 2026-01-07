# External Agent Task: Scanner Confidence Scoring (Phase 1B)

**Date:** 2026-01-07
**Priority:** MEDIUM
**Estimated Effort:** 2-3 hours
**Context:** Track 8 Phase 1B - Scanner Accuracy Enhancements

---

## Task Overview

Add confidence scoring to the Feature Alignment Scanner to help developers understand detection certainty. Currently, the scanner reports features as "used" or "orphan" but doesn't indicate how confident we are about each detection.

**What Exists:**
- ✅ Scanner with 0% false positive rate (Phase 1 complete)
- ✅ Dynamic detection via API helpers, HTML forms, auth patterns
- ✅ Foundation function `calculateEndpointConfidence()` (mentioned in Phase 1 summary)

**What You'll Build:**
- Confidence scoring algorithm (0-100 scale)
- Integration into scanner output (JSON + markdown reports)
- Confidence-based filtering in dashboard UI
- Documentation of scoring methodology

---

## Confidence Scoring Methodology

### Scoring Criteria (0-100 points)

**High Confidence (80-100):**
- Endpoint has **direct references** in frontend code
- Multiple evidence types (HTML form + JS fetch + docs)
- Recently modified files (active development)
- Clear semantic match between feature name and endpoint path

**Medium Confidence (50-79):**
- Endpoint referenced via **indirect patterns** (generic API wrappers)
- Single evidence type (only docs OR only frontend)
- Older files (last modified >90 days ago)
- Partial semantic match

**Low Confidence (20-49):**
- Endpoint detected via **auth pattern heuristics** only
- No frontend references found
- No documentation mentions
- Weak semantic match (generic names like `/api/data`)

**No Confidence (0-19):**
- Endpoint likely orphan (no evidence found)
- Manual review recommended

---

## Confidence Score Calculation

### Formula

```javascript
function calculateEndpointConfidence(endpoint, evidence) {
  let score = 0;
  const breakdown = {};

  // 1. Evidence Type (0-40 points)
  let evidenceScore = 0;
  if (evidence.frontend?.directFetch) evidenceScore += 20;      // fetch('/api/endpoint')
  if (evidence.frontend?.apiHelper) evidenceScore += 15;        // API.get('/api/endpoint')
  if (evidence.frontend?.htmlForm) evidenceScore += 15;         // <form action="/api/endpoint">
  if (evidence.docs?.explicitMention) evidenceScore += 10;      // Documented in specs
  breakdown.evidenceType = Math.min(evidenceScore, 40);
  score += breakdown.evidenceType;

  // 2. Evidence Count (0-20 points)
  const evidenceCount = (evidence.frontend?.references?.length || 0) +
                        (evidence.docs?.files?.length || 0);
  breakdown.evidenceCount = Math.min(evidenceCount * 5, 20);   // 5 pts per reference, max 20
  score += breakdown.evidenceCount;

  // 3. Semantic Match (0-20 points)
  const semanticScore = calculateSemanticMatch(endpoint.path, evidence.feature?.key);
  breakdown.semanticMatch = semanticScore;
  score += semanticScore;

  // 4. Recency (0-10 points)
  const recencyScore = calculateRecencyScore(evidence.lastModified);
  breakdown.recency = recencyScore;
  score += recencyScore;

  // 5. Auth Pattern Heuristic Penalty (-10 points)
  if (evidence.detectionMethod === 'auth-heuristic') {
    breakdown.authHeuristic = -10;
    score -= 10;
  }

  // 6. No Evidence Penalty (-30 points)
  if (evidenceCount === 0 && !evidence.frontend && !evidence.docs) {
    breakdown.noEvidence = -30;
    score -= 30;
  }

  return {
    score: Math.max(0, Math.min(100, score)),  // Clamp 0-100
    breakdown,
    confidence: getConfidenceLabel(score)
  };
}

// Helper: Semantic match between endpoint path and feature name
function calculateSemanticMatch(endpointPath, featureKey) {
  if (!featureKey) return 0;

  // Normalize paths
  const pathParts = endpointPath.toLowerCase().split('/').filter(Boolean);
  const featureParts = featureKey.toLowerCase().split('-');

  // Check for exact matches
  let exactMatches = 0;
  for (const part of featureParts) {
    if (pathParts.includes(part)) exactMatches++;
  }

  // Score: 20 points if all feature parts in path, scaled down
  const matchRatio = exactMatches / featureParts.length;
  return Math.round(matchRatio * 20);
}

// Helper: Recency scoring based on last modified date
function calculateRecencyScore(lastModified) {
  if (!lastModified) return 0;

  const daysSince = (Date.now() - new Date(lastModified)) / (1000 * 60 * 60 * 24);

  if (daysSince <= 7) return 10;       // Modified this week
  if (daysSince <= 30) return 7;       // Modified this month
  if (daysSince <= 90) return 5;       // Modified this quarter
  return 2;                             // Older than 90 days
}

// Helper: Confidence label
function getConfidenceLabel(score) {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  if (score >= 20) return 'low';
  return 'very-low';
}
```

---

## Implementation Steps

### Step 1: Update Scanner Service

**File:** `/src/services/featureAlignmentScanner.js`

**Changes:**

1. **Track Evidence During Scan:**
```javascript
// In scanFeatures() function, collect evidence for each endpoint
const endpointEvidence = new Map(); // Map<endpointPath, evidence>

// When detecting frontend references:
function recordFrontendEvidence(endpointPath, file, detectionMethod) {
  if (!endpointEvidence.has(endpointPath)) {
    endpointEvidence.set(endpointPath, {
      frontend: { references: [], methods: [] },
      docs: { files: [] },
      lastModified: null
    });
  }

  const evidence = endpointEvidence.get(endpointPath);
  evidence.frontend.references.push({ file, method: detectionMethod });
  evidence.frontend[detectionMethod] = true; // directFetch, apiHelper, htmlForm

  // Update lastModified
  const stats = fs.statSync(file);
  if (!evidence.lastModified || stats.mtime > evidence.lastModified) {
    evidence.lastModified = stats.mtime;
  }
}

// When detecting doc mentions:
function recordDocEvidence(endpointPath, docFile) {
  if (!endpointEvidence.has(endpointPath)) {
    endpointEvidence.set(endpointPath, {
      frontend: { references: [] },
      docs: { files: [] },
      lastModified: null
    });
  }

  const evidence = endpointEvidence.get(endpointPath);
  evidence.docs.files.push(docFile);
  evidence.docs.explicitMention = true;
}
```

2. **Calculate Confidence for Each Endpoint:**
```javascript
// After building features array, add confidence scores
for (const feature of features) {
  for (const endpoint of feature.backend?.endpoints || []) {
    const evidence = endpointEvidence.get(endpoint.path) || {};
    evidence.feature = { key: feature.key };

    const confidence = calculateEndpointConfidence(endpoint, evidence);
    endpoint.confidence = confidence;
  }
}

// For orphan endpoints
for (const orphan of orphanEndpoints) {
  const evidence = endpointEvidence.get(orphan.path) || {};
  const confidence = calculateEndpointConfidence(orphan, evidence);
  orphan.confidence = confidence;
}
```

3. **Add Confidence Functions:**
```javascript
// Add the calculateEndpointConfidence, calculateSemanticMatch,
// calculateRecencyScore, and getConfidenceLabel functions from above
```

### Step 2: Update Report Output

**File:** `/src/services/featureAlignmentScanner.js` (generateActionableReport function)

**Changes:**

1. **Add Confidence to JSON Output:**
```javascript
// In feature-alignment.json
{
  "features": [
    {
      "key": "chat",
      "backend": {
        "endpoints": [
          {
            "method": "POST",
            "path": "/api/chat",
            "sourceFile": "/routes/chat.js",
            "confidence": {
              "score": 95,
              "confidence": "high",
              "breakdown": {
                "evidenceType": 35,
                "evidenceCount": 20,
                "semanticMatch": 20,
                "recency": 10,
                "authHeuristic": 0,
                "noEvidence": 0
              }
            }
          }
        ]
      }
    }
  ]
}
```

2. **Add Confidence to Markdown Report:**
```markdown
### chat (Score: 95/100, Confidence: HIGH)

**Endpoints (3):**
- POST /api/chat (`chat.js`) - Confidence: 95 (HIGH) ✅
  - Evidence: Direct fetch (20), API helper (15), 4 references (20), semantic match (20), recent (10)
- GET /api/history (`history.js`) - Confidence: 78 (MEDIUM) ⚠️
  - Evidence: API helper (15), 2 references (10), semantic match (15), recent (10)
- POST /api/feedback (`feedback.js`) - Confidence: 42 (LOW) 🔍
  - Evidence: Auth heuristic only (-10), 1 doc mention (10), old file (2)
```

### Step 3: Update Dashboard UI

**File:** `/public/js/feature-alignment.js`

**Changes:**

1. **Display Confidence in Features Table:**
```javascript
// In renderFeaturesTable() function, add confidence column
function renderFeaturesTable() {
  const thead = `
    <tr onclick="handleSort(event)">
      <th data-sort="name">Feature Name</th>
      <th data-sort="score">Priority Score</th>
      <th data-sort="confidence">Confidence</th> <!-- NEW COLUMN -->
      <th data-sort="category">Category</th>
      <th data-sort="endpoints">Endpoints</th>
      <th data-sort="hasUI">Has UI?</th>
      <th>Actions</th>
    </tr>
  `;

  // In tbody loop:
  const avgConfidence = calculateAvgConfidence(feature.backend?.endpoints || []);
  const confidenceBadge = getConfidenceBadge(avgConfidence);

  row += `<td>${confidenceBadge}</td>`;
}

// Helper: Calculate average confidence across endpoints
function calculateAvgConfidence(endpoints) {
  if (!endpoints.length) return 0;
  const sum = endpoints.reduce((acc, ep) => acc + (ep.confidence?.score || 0), 0);
  return Math.round(sum / endpoints.length);
}

// Helper: Confidence badge HTML
function getConfidenceBadge(score) {
  let label, color;
  if (score >= 80) {
    label = 'HIGH';
    color = '#10b981'; // Green
  } else if (score >= 50) {
    label = 'MEDIUM';
    color = '#f59e0b'; // Yellow
  } else if (score >= 20) {
    label = 'LOW';
    color = '#ef4444'; // Red
  } else {
    label = 'VERY LOW';
    color = '#6b7280'; // Gray
  }

  return `<span class="confidence-badge" style="background: ${color}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">${label}</span>`;
}
```

2. **Add Confidence Filter:**
```javascript
// In filters-bar section of feature-alignment.html:
<div class="filter-group">
  <label>Confidence:</label>
  <select id="filter-confidence" class="filter-select" onchange="applyFilters()">
    <option value="all">All</option>
    <option value="high">High (80+)</option>
    <option value="medium">Medium (50-79)</option>
    <option value="low">Low (20-49)</option>
    <option value="very-low">Very Low (0-19)</option>
  </select>
</div>

// In applyFilters() function:
const confidenceFilter = document.getElementById('filter-confidence').value;
if (confidenceFilter !== 'all') {
  const avgConf = calculateAvgConfidence(feature.backend?.endpoints || []);
  if (confidenceFilter === 'high' && avgConf < 80) return false;
  if (confidenceFilter === 'medium' && (avgConf < 50 || avgConf >= 80)) return false;
  if (confidenceFilter === 'low' && (avgConf < 20 || avgConf >= 50)) return false;
  if (confidenceFilter === 'very-low' && avgConf >= 20) return false;
}
```

3. **Show Confidence in Feature Modal:**
```javascript
// In showFeatureModal() function, add confidence section:
modalBody += `
  <h4>Endpoint Confidence</h4>
  <div class="endpoint-confidence-list">
    ${feature.backend?.endpoints.map(ep => `
      <div class="endpoint-confidence-item">
        <span class="endpoint-path">${ep.method} ${ep.path}</span>
        <span class="confidence-score">${ep.confidence?.score || 0}/100</span>
        ${getConfidenceBadge(ep.confidence?.score || 0)}
        <button onclick="showConfidenceBreakdown('${ep.path}')">Details</button>
      </div>
    `).join('')}
  </div>
`;

// Add breakdown modal (nested modal or expandable section):
function showConfidenceBreakdown(endpointPath) {
  const endpoint = currentFeature.backend.endpoints.find(ep => ep.path === endpointPath);
  const breakdown = endpoint.confidence?.breakdown || {};

  const breakdownHtml = `
    <h4>Confidence Breakdown: ${endpointPath}</h4>
    <table>
      <tr><td>Evidence Type</td><td>${breakdown.evidenceType || 0} pts</td></tr>
      <tr><td>Evidence Count</td><td>${breakdown.evidenceCount || 0} pts</td></tr>
      <tr><td>Semantic Match</td><td>${breakdown.semanticMatch || 0} pts</td></tr>
      <tr><td>Recency</td><td>${breakdown.recency || 0} pts</td></tr>
      ${breakdown.authHeuristic ? `<tr><td>Auth Heuristic Penalty</td><td>${breakdown.authHeuristic} pts</td></tr>` : ''}
      ${breakdown.noEvidence ? `<tr><td>No Evidence Penalty</td><td>${breakdown.noEvidence} pts</td></tr>` : ''}
      <tr><td><strong>Total Score</strong></td><td><strong>${endpoint.confidence.score}/100</strong></td></tr>
    </table>
  `;

  // Display in modal or alert
  alert(breakdownHtml); // Replace with proper modal
}
```

### Step 4: Update Orphan Endpoints Table

**File:** `/public/js/feature-alignment.js` (renderOrphanEndpoints function)

**Changes:**

```javascript
// Add confidence column to orphan table
function renderOrphanEndpoints() {
  const thead = `
    <tr>
      <th>Status</th>
      <th>Method + Path</th>
      <th>Source File</th>
      <th>Confidence</th> <!-- NEW COLUMN -->
      <th>Category</th>
      <th>Actions</th>
    </tr>
  `;

  // In tbody loop:
  const confidenceBadge = getConfidenceBadge(orphan.confidence?.score || 0);
  row += `<td>${confidenceBadge}</td>`;
}
```

---

## Testing Checklist

### Scanner Output

1. **Run Scanner:**
```bash
cd /home/yb/codes/AgentX
node scripts/feature-alignment-scan.js
```

2. **Verify JSON Output:**
```bash
# Check that confidence scores exist
cat reports/feature-alignment.json | jq '.features[0].backend.endpoints[0].confidence'

# Expected output:
{
  "score": 95,
  "confidence": "high",
  "breakdown": {
    "evidenceType": 35,
    "evidenceCount": 20,
    "semanticMatch": 20,
    "recency": 10
  }
}
```

3. **Verify Markdown Report:**
```bash
# Check that confidence appears in report
grep -A 5 "Confidence:" reports/feature-alignment-actions.md
```

### Dashboard UI

4. **Open Dashboard:**
```
http://localhost:3080/feature-alignment.html
```

5. **Verify Confidence Column:**
- Features table should show confidence badges
- High confidence = green badge
- Medium = yellow
- Low = red

6. **Test Confidence Filter:**
- Select "High (80+)" → Should filter to only high-confidence features
- Select "Low (20-49)" → Should filter to low-confidence features

7. **Test Feature Modal:**
- Click "View Details" on any feature
- Should show confidence scores for each endpoint
- Click "Details" button → Should show breakdown

---

## Acceptance Criteria

1. ✅ **Scanner Calculates Confidence:**
   - Every endpoint has confidence score (0-100)
   - Confidence breakdown with 6 criteria tracked
   - Evidence tracked during scan (frontend refs, docs, recency)

2. ✅ **JSON Report Includes Confidence:**
   - `endpoint.confidence.score` field
   - `endpoint.confidence.confidence` label (high/medium/low/very-low)
   - `endpoint.confidence.breakdown` object

3. ✅ **Markdown Report Shows Confidence:**
   - Confidence badges (✅/⚠️/🔍) next to endpoints
   - Confidence score and label in feature sections

4. ✅ **Dashboard Displays Confidence:**
   - Confidence column in features table
   - Confidence filter in filters bar
   - Confidence badges color-coded correctly
   - Feature modal shows per-endpoint confidence

5. ✅ **Confidence Scores Make Sense:**
   - Direct fetch references → High confidence (80+)
   - Auth heuristics only → Low confidence (<50)
   - Multiple evidence types → Higher scores
   - Recent files → Higher scores

---

## Documentation Updates

### Update User Guide

**File:** `/docs/FEATURE_ALIGNMENT_DASHBOARD_GUIDE.md`

**Add Section:**

```markdown
## Understanding Confidence Scores

Confidence scores (0-100) indicate how certain we are that an endpoint is correctly linked to its feature.

**High Confidence (80-100):** ✅
- Direct frontend references via `fetch()` or `API.get()`
- Multiple evidence sources (HTML forms, docs, tests)
- Recently modified files (active development)
- Clear semantic match between feature and endpoint names

**Medium Confidence (50-79):** ⚠️
- Indirect references (generic API wrappers)
- Single evidence source (only docs OR only frontend)
- Older files (last modified >90 days ago)
- Partial semantic match

**Low Confidence (20-49):** 🔍
- Auth pattern heuristics only (endpoint has `requireAuth` middleware)
- No frontend references found
- No documentation mentions
- Weak semantic match (generic names)

**Very Low Confidence (0-19):** ⚠️
- Likely orphan (no evidence found)
- Manual review recommended

### Interpreting Scores

**Score 95:** "We're very confident this endpoint is used"
- Example: `/api/chat` with direct fetch calls in `chat.js`, documented in specs, modified this week

**Score 65:** "Probably used, but worth double-checking"
- Example: `/api/dashboard/stats` with API helper references, no docs, modified 2 months ago

**Score 30:** "Uncertain, may be orphan"
- Example: `/api/internal/cleanup` with requireAuth middleware but no frontend/doc references

**Score 5:** "Likely orphan, needs investigation"
- Example: `/api/legacy/endpoint` with no evidence at all
```

---

## Expected Outcomes

After implementation:
- **Better Decision Making:** Developers know which low-priority features to investigate first (low confidence = uncertain)
- **Quality Metrics:** Track scanner accuracy over time (average confidence score)
- **Reduced False Negatives:** Low-confidence detections flag potential gaps in scanner logic
- **Actionable Reports:** "Fix low-confidence endpoints" becomes a concrete task

---

## Notes

- This is **Phase 1B** - enhancing scanner accuracy, not adding new detection methods
- Confidence scoring is **informational** - doesn't change orphan detection logic
- Future phases could use confidence to auto-filter reports (e.g., hide low-confidence orphans)
- Consider adding confidence trends over time (compare scans)

**Good luck! This enhancement will make the scanner even more valuable for developers.**
