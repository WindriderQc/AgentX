# Feature Alignment Priority Algorithm

**Version:** 2.0 (Enhanced 7-Criteria)
**Date:** 2026-01-07
**Implementation:** `/src/services/featureAlignmentPriority.js`

## Overview

The priority algorithm scores features 0-100 to determine which headless features should receive UI development priority. Features are scored across 7 criteria and categorized into priority levels.

## Scoring Criteria (7 Total)

### 1. n8n Workflow Usage (±30 points)

**Purpose:** Distinguish between API-only endpoints and features used BY workflows

**Logic:**
- **+30 points** - Feature is consumed by n8n workflows (matches workflow name/ID)
- **-30 points** - Feature IS an n8n webhook endpoint (API-only, no UI needed)
- **0 points** - No n8n relationship

**Implementation:**
```javascript
// Check if feature name matches workflow names
const workflows = getN8nWorkflows(rootDir);
for (const wf of workflows) {
  if (featureName.includes(wf.name.toLowerCase())) {
    return 30; // Used BY n8n
  }
}

// Check if endpoints ARE n8n webhooks
for (const ep of endpoints) {
  if (ep.path.includes(wf.webhook)) {
    return -30; // IS n8n webhook (API-only)
  }
}
```

**Example:**
- Feature "deployment" matches N0.0 workflow "Deployment Test" → +30 points
- Endpoint `/api/webhooks/sbqc-health` matches N0.1 webhook → -30 points

### 2. Endpoint Count (20 points)

**Purpose:** More endpoints = more functionality = higher priority

**Scale:**
- **20 points** - 11+ endpoints
- **15 points** - 6-10 endpoints
- **10 points** - 3-5 endpoints
- **5 points** - 1-2 endpoints

**Example:**
- model-registry: 12 endpoints → 20 points
- voice: 4 endpoints → 10 points
- database: 1 endpoint → 5 points

### 3. Documentation Thoroughness (20 points)

**Purpose:** Well-documented features are more important and easier to build

**Scale:**
- **10 points** - Has any documentation files
- **+5 points** - Has specs/, contracts, or API-REFERENCE docs
- **+5 points** - Mentioned in ROADMAP, PLAN, or IMPLEMENTATION docs

**Max:** 20 points

**Implementation:**
```javascript
let docScore = 0;
if (docs.length > 0) docScore += 10;
if (docs.some(d => d.includes('specs/') || d.includes('API-REFERENCE'))) docScore += 5;
if (docs.some(d => d.includes('ROADMAP') || d.includes('IMPLEMENTATION'))) docScore += 5;
```

**Example:**
- voice: 12 docs including API-REFERENCE → 20 points
- deployment: 8 docs including ROADMAP → 15 points

### 4. Security/Admin Requirements (15 points)

**Purpose:** Auth-required features are production-critical

**Scale:**
- **10 points** - Uses `requireAuth` middleware
- **+5 points** - Uses `requireAdmin` or role-based access

**Max:** 15 points

**Implementation:**
```javascript
for (const file of routeFiles) {
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('requireAuth')) score += 10;
  if (content.includes('requireAdmin') || content.includes('isAdmin')) score += 5;
}
```

**Example:**
- Workspace routes with requireAuth + requireAdmin → 15 points
- Public endpoints with no auth → 0 points

### 5. Recent Activity (15 points)

**Purpose:** Recently modified features are actively maintained

**Scale:**
- **15 points** - Modified within 7 days
- **10 points** - Modified within 30 days
- **5 points** - Modified within 90 days
- **0 points** - No recent activity

**Implementation:**
```javascript
const commitTime = getLastModifiedDate(file, rootDir);
const diffDays = (now - commitTime) / (1000 * 60 * 60 * 24);

if (diffDays <= 7) return 15;
if (diffDays <= 30) return 10;
if (diffDays <= 90) return 5;
return 0;
```

**Example:**
- Feature modified yesterday → 15 points
- Feature modified 3 months ago → 0 points

### 6. False Positive Penalty (-15 points)

**Purpose:** Penalize scanner detection errors

**Condition:** Feature has frontend files but marked as "headless-documented"

**Logic:**
```javascript
if (frontendFiles.length > 0 && feature.status === 'headless-documented') {
  score -= 15;
}
```

**Example:**
- Feature marked headless but has `public/feature.html` → -15 points

### 7. UI Detection Penalty (-20 points)

**Purpose:** Features with UIs are not truly headless

**Condition:** Feature has any frontend files

**Logic:**
```javascript
if (frontendFiles.length > 0) {
  score -= 20;
}
```

**Example:**
- Feature with `public/dashboard.html` → -20 points
- Feature with no frontend → 0 penalty

## Category Assignment

### API-Only
**Criteria:**
- n8n score < 0 (IS n8n webhook), OR
- Endpoint in API_ONLY_ENDPOINTS list

**Result:** Marked as "api-only", excluded from UI recommendations

### Critical (score >= 70)
**Level:** CRITICAL
**Action:** Immediate UI development recommended
**Example:** Feature with 11+ endpoints, full docs, auth, recent activity

### High (score >= 50)
**Level:** HIGH
**Action:** UI development strongly recommended
**Example:** Feature with 6+ endpoints, good docs, moderate activity

### Medium (score >= 30)
**Level:** MEDIUM
**Action:** Consider UI if users request frequently
**Example:** Feature with 3-5 endpoints, some docs

### Low (score < 30)
**Level:** LOW
**Action:** Low priority, may be API-only
**Example:** Feature with 1-2 endpoints, minimal docs

### Complete
**Criteria:** feature.status === 'complete'
**Level:** COMPLETE
**Action:** Already has UI, no action needed

## Known Endpoint Lists

### False Positive Endpoints (In Use)
```javascript
const FALSE_POSITIVE_ENDPOINTS = [
  'POST /api/feedback',           // Used by chat.js feedback buttons
  'POST /register',               // User registration flow
  'POST /logout',                 // Session termination
  'GET /me',                      // Current user identity
  'GET /api/dashboard/health',    // System health
  'GET /api/dashboard/stats',     // Dashboard metrics
  'GET /api/dashboard/scans'      // Scan history
];
```

### API-Only Endpoints (By Design)
```javascript
const API_ONLY_ENDPOINTS = [
  'GET /api/models/routing',      // Model routing inspection
  'POST /api/models/classify',    // Query classification preview
  'GET /api/models/health'        // Model health check
];
```

## Example Calculations

### Example 1: Voice API (Score: 30)
```
+ n8n Workflow Usage:    0  (no workflow match)
+ Endpoint Count:       10  (4 endpoints)
+ Documentation:        20  (12 docs including API-REFERENCE)
+ Security/Admin:        0  (no auth requirements)
+ Recent Activity:       0  (no recent commits)
+ False Positive:        0  (correctly marked headless)
+ UI Detection:          0  (no frontend files)
─────────────────────────
= Total Score:          30  (MEDIUM priority)
```

**Recommendation:** Consider building UI for voice testing and monitoring

### Example 2: Model Registry (Score: 40)
```
+ n8n Workflow Usage:    0  (no workflow match)
+ Endpoint Count:       20  (12 endpoints)
+ Documentation:        20  (full docs with API-REFERENCE)
+ Security/Admin:        0  (no auth requirements)
+ Recent Activity:       0  (no recent commits)
+ False Positive:        0  (correctly marked headless)
+ UI Detection:          0  (no frontend files)
─────────────────────────
= Total Score:          40  (MEDIUM priority)
```

**Recommendation:** Build UI for model catalog management

### Example 3: Deployment (Score: 45)
```
+ n8n Workflow Usage:   30  (matches N0.0 "Deployment Test")
+ Endpoint Count:        0  (no direct endpoints)
+ Documentation:        15  (8 docs including ROADMAP)
+ Security/Admin:        0  (no auth requirements)
+ Recent Activity:       0  (no recent commits)
+ False Positive:        0  (correctly marked headless)
+ UI Detection:          0  (no frontend files)
─────────────────────────
= Total Score:          45  (MEDIUM priority)
```

**Recommendation:** Consider UI if deployment testing is frequent

### Example 4: n8n Webhook (Score: -30)
```
+ n8n Workflow Usage:  -30  (IS n8n webhook endpoint)
+ Endpoint Count:        5  (1-2 endpoints)
+ Documentation:        10  (minimal docs)
+ Security/Admin:        0  (no auth requirements)
+ Recent Activity:       0  (no recent commits)
+ False Positive:        0  (correctly marked)
+ UI Detection:          0  (no frontend files)
─────────────────────────
= Total Score:         -15  (API-ONLY)
```

**Recommendation:** No UI needed (programmatic n8n access only)

## Usage in Scanner

```javascript
const { calculatePriority } = require('../src/services/featureAlignmentPriority');

report.features.forEach(f => {
  f.priority = calculatePriority(f, rootDir);
  // Returns: { score, level, category, breakdown }
});
```

## Report Generation

**Filtering:**
1. Filter `status === 'headless-documented'`
2. Exclude `category === 'api-only'`
3. Exclude `category === 'complete'`
4. Sort by `priority.score` descending
5. Take top 10

**Display:**
- Show all 7 criteria in breakdown
- Add "Why Build UI" explanation based on score
- Suggest UI location: `/public/{feature-key}.html`

## Future Enhancements

1. **User Request Tracking** - Add points for user-requested features
2. **API Usage Analytics** - Bonus for frequently called endpoints
3. **Dependency Analysis** - Points for features required by other features
4. **Business Impact** - Manual weighting for strategic features
5. **Technical Debt** - Penalty for legacy code without tests

## References

- Implementation: `/src/services/featureAlignmentPriority.js`
- Scanner: `/scripts/feature-alignment-scan.js`
- Output: `/reports/feature-alignment-actions.md`
- n8n Workflows: `/routes/operations.js` (WORKFLOWS array)
