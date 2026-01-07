# Sub-Agent Prompt: Phase 2 Investigation Tasks

**Role:** Exploration and Analysis Agent
**Purpose:** Investigate low-confidence features and frontend signal detection gaps
**Context:** After CLAUDE.md refactoring, we need to understand scanner detection issues

---

## Task Option A: Low-Confidence Feature Review

**Objective:** Review 21 "very low" confidence features (<20 points) to determine if scanner gap or genuinely unused

**Data Source:** `/reports/VALIDATION_REPORT_CONFIDENCE.md`

**Your Mission:**

1. **Read the validation report** to understand confidence scoring:
   - 6-criteria algorithm (0-100 scale)
   - Evidence types: direct fetch, API helper, HTML form, docs
   - Current average: 34.6/100

2. **Extract the 21 "very low" confidence features** (<20 points):
   - Use Grep to find features with confidence <20
   - Create list with: endpoint, method, feature name, confidence score

3. **For each of the 21 features, investigate:**

   a. **Frontend Usage Check:**
   - Search for endpoint in `/public/**/*.js` files
   - Look for:
     - Direct fetch calls: `fetch('/api/endpoint')`
     - API helper calls: `API.get('/api/endpoint')`
     - HTML form actions: `<form action="/api/endpoint"`
   - Check `/public/**/*.html` for references

   b. **Backend Implementation Check:**
   - Find route definition in `/routes/*.js`
   - Check if handler exists and is functional
   - Verify it's not deprecated or archived

   c. **Documentation Check:**
   - Search in `/docs/**/*.md` for mentions
   - Check if documented as intentionally headless (API-only)
   - Look for "TODO" or "WIP" markers

4. **Categorize each feature:**
   - **Scanner Gap:** Frontend uses endpoint but scanner didn't detect it
   - **Genuinely Unused:** No frontend references, candidate for deprecation
   - **Documented Headless:** Intentionally API-only (n8n, external tools)
   - **False Negative:** Scanner assigned wrong feature name

5. **Provide recommendations:**
   - For scanner gaps: What detection method would catch this?
   - For unused features: Should we deprecate?
   - For mis-assignments: Correct feature name?

**Output Format:**

```markdown
# Low-Confidence Feature Analysis Report

**Date:** [Date]
**Features Analyzed:** 21

## Summary

- Scanner Gaps: X features
- Genuinely Unused: X features
- Documented Headless: X features
- False Negatives: X features

## Detailed Findings

### 1. [Endpoint Name] - [Category]

**Confidence:** X/100
**Endpoint:** [METHOD] /api/path
**Assigned Feature:** [Feature name]

**Frontend Evidence:**
- Found in: [files]
- Usage pattern: [direct fetch / API helper / form]
- Line references: [line numbers]

**Backend Status:**
- Route file: /routes/[file].js
- Handler: [exists / missing]
- Status: [active / deprecated]

**Documentation:**
- Mentions: [count]
- Files: [list]
- Headless: [yes / no]

**Categorization:** [Scanner Gap / Unused / Headless / False Negative]

**Recommendation:** [Specific action]

---

[Repeat for all 21 features]

## Scanner Improvement Recommendations

1. [Detection method to add]
2. [Pattern to recognize]
3. [Documentation to create]

## Deprecation Candidates

1. [Endpoint] - Reason: [unused for X months, no frontend refs]

## Re-assignment Needed

1. [Endpoint] - Current: [X], Should be: [Y]
```

---

## Task Option B: Frontend Signal Investigation

**Objective:** Analyze why average confidence is only 34.6/100 (indicates missing frontend signals)

**Your Mission:**

1. **Sample 15 medium/low confidence features** (20-50 points):
   - Select mix of different feature types
   - Include both API and UI endpoints
   - Focus on features you know ARE used

2. **For each sampled feature, trace frontend → backend:**

   a. **Identify all frontend entry points:**
   - Direct fetch calls
   - API helper usage (API.get, API.post, etc.)
   - HTML form submissions
   - Event handlers calling endpoints
   - Import statements for API clients

   b. **Check scanner detection:**
   - Did scanner find direct fetch? (should give 40 pts)
   - Did scanner find API helper? (should give 30 pts)
   - Did scanner find HTML form? (should give 20 pts)
   - Did scanner find documentation? (should give 10 pts)

   c. **Identify WHY scanner missed signals:**
   - Dynamic path construction? (e.g., ``fetch(`/api/${type}/list`)``)
   - Stored in variables? (e.g., `const endpoint = '/api/chat'; fetch(endpoint)`)
   - Imported from config? (e.g., `import { API_ENDPOINTS } from './config'`)
   - Template literals? (e.g., `fetch(config.baseUrl + '/chat')`)
   - Indirect calls? (e.g., `apiClient.chat()` wraps `fetch('/api/chat')`)

3. **Analyze patterns:**
   - What % of missed signals are due to dynamic construction?
   - What % are due to helper abstraction?
   - What % are due to config/constant indirection?
   - What % are genuinely difficult to detect?

4. **Provide recommendations:**
   - Detection methods to add (AST parsing? Variable tracking?)
   - Code patterns to recognize (template literals, config imports)
   - Documentation improvements (explicit endpoint lists)

**Output Format:**

```markdown
# Frontend Signal Investigation Report

**Date:** [Date]
**Features Analyzed:** 15

## Executive Summary

Average confidence: 34.6/100 indicates scanner is missing ~65% of frontend signals.

**Root Causes:**
- Dynamic path construction: X% of cases
- Helper abstraction: X% of cases
- Config indirection: X% of cases
- Other: X% of cases

## Detailed Analysis

### 1. [Feature Name] - Confidence: X/100

**Endpoint:** [METHOD] /api/path

**Frontend Usage:**
- File: `/public/js/[file].js:123`
- Pattern: `fetch(\`/api/${type}/list\`)` ← Dynamic construction
- Scanner found: NO (missed due to template literal)

**Expected Confidence:** 40 pts (direct fetch)
**Actual Confidence:** X pts
**Gap:** 40 - X = Y pts

**Why Missed:** Template literal with variable interpolation

---

[Repeat for all 15 features]

## Pattern Analysis

### Dynamic Path Construction (X cases)

**Examples:**
```javascript
// Case 1: Template literal with variable
fetch(`/api/${resource}/list`)

// Case 2: Concatenation
fetch(API_BASE + '/endpoint')

// Case 3: Object property
fetch(endpoints[action])
```

**Detection Strategy:**
- AST parsing to extract template literals
- Variable tracking to resolve endpoint values
- Constant analysis for config objects

### Helper Abstraction (X cases)

**Examples:**
```javascript
// Case 1: API client wrapper
apiClient.getHistory()  // wraps fetch('/api/history')

// Case 2: Utility function
fetchData('history')  // constructs '/api/' + type
```

**Detection Strategy:**
- Trace API helper method definitions
- Map method names to endpoints
- Document helper → endpoint mapping

### Config Indirection (X cases)

**Examples:**
```javascript
// Case 1: Imported constants
import { ENDPOINTS } from './config'
fetch(ENDPOINTS.HISTORY)

// Case 2: Environment-based
fetch(config.api.base + '/history')
```

**Detection Strategy:**
- Parse config files for endpoint definitions
- Resolve imported constants
- Build endpoint constant map

## Recommendations

### High Priority (Implement Next)

1. **Template Literal Detection:**
   - Tool: Babel/ESLint AST parser
   - Pattern: Match `/api/${var}` patterns
   - Extract static prefix: `/api/`
   - Flag as "dynamic endpoint" (partial credit)

2. **API Helper Mapping:**
   - Manually document: `API.getHistory()` → `GET /api/history`
   - Create mapping file: `/scripts/api-helper-map.json`
   - Scanner reads mapping for endpoint resolution

3. **Config Constant Extraction:**
   - Parse `/public/js/config.js` for endpoint definitions
   - Build constant → endpoint map
   - Resolve references during scan

### Medium Priority

4. **Variable Tracking:**
   - Track: `const endpoint = '/api/chat'`
   - Resolve: `fetch(endpoint)` → `fetch('/api/chat')`
   - Complexity: MODERATE (requires data flow analysis)

5. **Documentation Enhancement:**
   - Add explicit endpoint list to each frontend file
   - Comment format: `// Endpoints: GET /api/history, POST /api/chat`
   - Scanner parses comments for hints

### Low Priority (Long-term)

6. **Full AST Analysis:**
   - Build complete call graph
   - Trace all fetch → endpoint paths
   - Complexity: HIGH (engineering effort)

## Expected Impact

**If High Priority recommendations implemented:**
- Average confidence: 34.6 → 55-65 (est.)
- Detection coverage: ~35% → ~60%
- False negatives: -40%

**Timeline:** 4-6 hours implementation + testing

---

**Completed:** [Date]
**Agent:** [Sub-agent ID]
```

---

## Execution Guidelines

1. **Be thorough but efficient:**
   - Don't analyze every line of every file
   - Sample strategically (diverse feature types)
   - Focus on high-impact findings

2. **Use proper tools:**
   - Glob for file discovery
   - Grep for content search
   - Read for detailed inspection

3. **Document patterns, not just instances:**
   - We want to understand WHY signals are missed
   - Generalizable findings are more valuable than edge cases

4. **Provide actionable recommendations:**
   - Each recommendation should have:
     - What to implement
     - How to implement (tools/approach)
     - Expected impact (confidence boost)
     - Estimated effort

---

## Questions?

If you need clarification:
- Read `/reports/VALIDATION_REPORT_CONFIDENCE.md` for scanner details
- Check `/src/services/featureAlignmentScanner.js` for current detection logic
- Review `/src/services/scannerConfidence.js` for confidence scoring algorithm

---

**Ready to Execute:** ✅
**Choose:** Task Option A (review 21 features) OR Task Option B (investigate signals)
**Estimated Time:** 2-3 hours per task
