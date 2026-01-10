# Task Package 4: Database Schema Design

This directory contains the Mongoose schema definitions and validation tests for the Feature Alignment Dashboard.

## Deliverables

### Models (`models/`)

1.  **FeatureInventory.js**
    *   Tracks codebase features across frontend, backend, and documentation.
    *   Includes `calculateAlignmentScore()` to audit feature completeness.
    *   `getAlignmentReport()` aggregator for dashboard reporting.

2.  **ApiTelemetry.js**
    *   Stores API metrics (hits, latency, errors) aggregated by time period.
    *   Support for hourly/daily/weekly rollups.
    *   Helper methods: `recordCall`, `getTopEndpoints`, `getUnusedEndpoints`.

3.  **FeatureUsage.js**
    *   Tracks user interactions with specific features (views, clicks).
    *   Helper methods: `getFeatureAdoption`, `getUserFeatureProfile`.
    *   Compound indexes for efficient analytics queries.

4.  **FeatureFlag.js**
    *   Manages feature toggles with rollout percentages and user/env overrides.
    *   Deterministic `checkRollout(userId)` using consistent hashing.

### Tests (`tests/`)

*   **unit/schemas.test.js**: Unit tests for schema validation, enum constraints, defaults, and helper logic/math.

## Usage

These models are designed for MongoDB + Mongoose. To use them in the main application:

1.  Copy the files from `models/` to `AgentX/models/`.
2.  Copy the test file to `AgentX/tests/unit/`.
3.  Ensure Mongoose is connected before querying.

## Alignment with Spec

All requirements from Task Package 4 have been implemented:
*   Exact field names and types.
*   Specified indexes (simple and compound).
*   Required static and instance methods.
*   Enums and default values.
