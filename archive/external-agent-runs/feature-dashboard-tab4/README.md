# Feature Flags & Admin Dashboard Integration

This directory contains the standalone frontend for the Admin Controls tab of the Feature Alignment Dashboard.

## Contents

- `features-admin.html`: The HTML structure for the admin dashboard.
- `features-admin.js`: The JavaScript logic (currently using mock data).
- `features-admin.css`: The styling for the admin interface.

## Integration Guide

### 1. Copy Files

Copy these files into your main public assets directory:

```bash
cp feature-dashboard-tab4/* /path/to/your/project/public/admin/
```

### 2. Backend API Requirements

The `features-admin.js` file is currently using mock data. To connect it to your backend, you will need to implement the following API endpoints:

**GET /api/features/flags**
Returns all feature flags:
```json
[
  {
    "name": "voice-input",
    "enabled": false,
    "description": "Voice input feature",
    "scope": "global",
    "rolloutPercentage": 0,
    "updated": "2h ago"
  }
]
```

**POST /api/features/flags**
Create a new flag. Body: `{ "name": "...", "description": "...", "scope": "...", "rolloutPercentage": 0 }`

**PUT /api/features/flags/:name**
Update a flag. Body: `{ "enabled": true, ... }`

**DELETE /api/features/flags/:name**
Delete a flag.

**POST /api/features/inventory/scan**
Triggers the code scan.

**POST /api/features/telemetry/clear**
Clears all telemetry data.

**GET /api/features/alignment-report**
Returns the report file (CSV/JSON).

### 3. Switch to Real Data

In `features-admin.js`, locate `loadFlags()` and `toggleFlag()` and replace the array manipulation code with `fetch()` calls to the endpoints above.

Example for `loadFlags()`:
```javascript
async function loadFlags() {
    try {
        const res = await fetch('/api/features/flags');
        featureFlags = await res.json();
        // ... render logic
    } catch(err) {
        showToast('Failed to load flags', 'error');
    }
}
```

## Dependencies
- FontAwesome (included via CDN in HTML)
- Google Fonts (system font stack used)
