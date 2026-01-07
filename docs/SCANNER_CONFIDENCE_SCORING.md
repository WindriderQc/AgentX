# Scanner Confidence Scoring Methodology

**Version:** 1.0
**Date:** 2026-01-07
**Implementation:** `/src/services/scannerConfidence.js`

## Overview

The confidence scoring algorithm (0-100) helps developers understand the certainty of feature detection by the scanner. It is particularly useful for distinguishing between truly orphaned endpoints and those that are used but detected via heuristic methods.

The confidence score is calculated per-endpoint and aggregated for features.

## Scoring Criteria (0-100 points)

### 1. Evidence Type (0-40 points)
Scores based on the *kind* of evidence found in the codebase.
- **+20 points:** Direct `fetch()` call to the endpoint URL.
- **+15 points:** Usage via API helper (e.g., `API.get()`, `axios.post()`).
- **+15 points:** HTML Form action (`<form action="...">`).
- **+10 points:** Explicit mention in documentation files.
*Max capped at 40 points.*

### 2. Evidence Count (0-20 points)
Scores based on the volume of references found.
- **+5 points** per reference (frontend file or doc file).
*Max capped at 20 points.*

### 3. Semantic Match (0-20 points)
Scores based on how well the endpoint path matches the feature key it is assigned to.
- **+20 points** (max): Full match of all path segments to feature name tokens.
- Scaled downward for partial matches.

### 4. Recency (0-10 points)
Scores based on the last modification date of the evidence files or the endpoint source file.
- **10 points:** Modified in the last 7 days.
- **7 points:** Modified in the last 30 days.
- **5 points:** Modified in the last 90 days.
- **2 points:** Older than 90 days.

### 5. Penalties
- **-10 points:** Detection via Auth Heuristic (e.g., `/login`, `/me`) if no other evidence exists.
- **-30 points:** No Evidence found (likely orphan).

## Confidence Levels

| Level | Score Range | Description |
|-------|-------------|-------------|
| **High** | 80-100 | Confirmed usage with direct references and documentation. |
| **Medium**| 50-79 | Likely usage, indirect references or older code. |
| **Low** | 20-49 | Weak evidence, heuristics only. |
| **Very Low** | 0-19 | No evidence found, likely orphan or API-only. |

## Integration

- **Reports:** JSON and Markdown reports now include confidence scores for Feature Endpoints and Orphan Endpoints.
- **Dashboard:** The Feature Alignment Dashboard displays confidence badges and allows filtering by confidence level.
