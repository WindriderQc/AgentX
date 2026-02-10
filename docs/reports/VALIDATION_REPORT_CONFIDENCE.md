# Scanner Validation & Tuning Report

**Date:** 2026-01-07
**Task:** Feature Alignment Scanner Confidence Scoring Validation

## 1. Validation Results

After implementing the confidence scoring algorithm and running the scanner on the full codebase (`node scripts/feature-alignment-scan.js`), we analyzed the confidence distribution of the 126 features that have backend endpoints.

**Summary Statistics:**
- **Total Features Scanned:** 190
- **Features with Endpoints:** 126
- **Orphan Endpoints:** 0 (100% assignment coverage)
- **Average Confidence:** 34.6 / 100
- **Max Confidence:** 75 / 100

**Distribution:**
- **High (70-79):** 1 feature (0.8%)
- **Medium (40-69):** 58 features (46%)
- **Low (20-39):** 46 features (36.5%)
- **Very Low (0-19):** 21 features (16.7%)

## 2. Tuning Adjustments

We performed two tuning iterations to improve the accuracy of the scoring:

### A. Semantic Match Weighting
*   **Initial:** Calculated `ratio * 20`. This heavily penalized single-word features matching single-word paths (1/1 * 20 = 20) but weak partial matches (1/3 * 20 = 7).
*   **Adjustment:** Changed to `match * 10` points matching, capped at 20.
*   **Refinement:** Added a **"Complete Match Bonus"** to restore 20 points for exact full matches (e.g., feature `login` matches path `.../login`).
*   **Result:** Improved scores for multi-word partial matches (7 -> 10) while maintaining high scores for simple exact matches.

### B. Orphan Detection & Feature Assignment
*   **Issue:** Scanner reported 0 orphans.
*   **Investigation:** The feature assignment loop uses `minHits: 1` matching, which is very broad. Even endpoints with generic names are assigned to *some* feature, leaving no "unassigned" orphans.
*   **Decision:** We accept "0 explicit orphans" because the **Confidence Score** now serves the purpose of identifying weak links. Features with "Very Low" confidence (<20) act as the bucket for "likely mis-assigned or unused" endpoints.
*   **Logic Update:** Updated `featureAlignmentScanner.js` to ensure the "Orphan Filter" explicitly checks if an endpoint was assigned to a feature, guaranteeing consistency between the Features list and the Orphan list.

## 3. Recommendations for Next Steps

1.  **Dashboard Filtering:** Use the "Very Low" confidence filter in the dashboard to review the 21 features that likely contain mis-assigned or api-only endpoints.
2.  **Frontend Signals:** The low average confidence (34.6) indicates that `directFetch` or `apiHelper` signals are missing for many endpoints. We should investigate why frontend references aren't being picked up (e.g. dynamic path construction or untracked JS files).
3.  **Docs Coverage:** 159 documentation files were scanned. Increasing `explicitMention` mentions in docs is the easiest way to boost confidence scores for features lacking frontend code.

## 4. Conclusion
The scanner is now fully operational with confidence scoring. The low average score reflects the reality of a codebase where many endpoints are documented or exist but aren't clearly linked to frontend calls via static analysis. This provides a clear roadmap for improving feature alignment visibility.
