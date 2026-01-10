# Feature Inventory Scanning Algorithm Logic

## Overview
This document describes the logic and patterns used by the `FeatureInventoryService` to detect features across the AgentX codebase (Frontend, Backend, and Documentation) and align them to generate a consistency report.

## Scanning Logic

### 1. Frontend Scanning
**Target Directories:** `public/` (recursively)

- **HTML Files (`.html`)**:
  - **ID Extraction**: Filename basename (lowercase, dash-separated).
    - Example: `user-profile.html` -> `user-profile`
  - **Name Extraction**: 
    - Priority 1: Content of `<title>...</title>` tag.
    - Priority 2: Filename converted to Title Case (`user-profile` -> `User Profile`).
  - **Regex**: `/<title>(.*?)<\/title>/`

- **JavaScript Files (`.js`)**:
  - **Heuristic**: Detects Controller classes which often map 1:1 to features.
  - **Regex**: `/class\s+([A-Z][a-zA-Z0-9]+)Controller/`
  - **ID Extraction**: The captured group converted to lowercase.
    - Example: `class AuthController` -> `auth`

### 2. Backend Scanning
**Target Directories:** `routes/` and `src/services/`

- **Route Files**:
  - **File Pattern**: `*Routes.js` (e.g., `authRoutes.js`).
  - **ID Extraction**: Filename with 'Routes.js' removed.
  - **Endpoint Detection**: Scans for Express router definitions.
  - **Regex**: `/router\.(get|post|put|delete)\(['"]\/([^'"]*)['"]/g`
    - Captures the HTTP method and path.
  
- **Service Files**:
  - **File Pattern**: `*Service.js` (e.g., `AuthService.js`).
  - **ID Extraction**: Filename with 'Service.js' removed.

### 3. Documentation Scanning
**Target Directories:** `docs/` and root `.md` files.

- **Markdown Files**:
  - **ID Extraction**: Filename basename (lowercase).
  - **Name Extraction**: First H1 header in the file.
  - **Regex**: `/^#\s+(.+)$/m`

## Alignment & Scoring Logic

The matcher aligns items based on their normalized **ID**.

### Scoring System
- **Base Score**: 0 starts.
- **Frontend Presence**: +0.33
- **Backend Presence**: +0.33
- **Documentation Presence**: +0.33

*(Scores > 0.9 are rounded to 1.0)*

### Status Classification
- **Perfect Match** (Score 1.0): Feature exists in Frontend, Backend, and Documentation.
- **Partial Match** (Score 0.34 - 0.99): Feature exists in 2 out of 3 locations.
- **Orphaned** (Score < 0.34): Feature exists in only 1 location.

## Usage
Execute the `generateAlignmentReport()` method to run the full scan and receive a JSON array of aligned features.
