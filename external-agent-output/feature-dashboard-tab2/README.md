# API Telemetry Dashboard (Tab 2)

This component provides real-time visibility into API hits, latency, errors, and unused endpoints.

## Files
- `features-telemetry.html`: The HTML structure.
- `features-telemetry.js`: The logic (currently using mock data).
- `features-telemetry.css`: Styles for the dashboard.

## Integration Instructions

1. **Include Feature**:
   Copy the HTML content from `features-telemetry.html` into your main dashboard HTML structure (e.g., inside a tab pane).

2. **Add Dependencies**:
   Ensure Chart.js is included in your main page if not already present:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
   ```

3. **Link Styles**:
   Include the CSS file in your `<head>`:
   ```html
   <link rel="stylesheet" href="path/to/features-telemetry.css">
   ```

4. **Link Script**:
   Include the JS file at the end of your `<body>`:
   ```html
   <script src="path/to/features-telemetry.js"></script>
   ```

## Backend Integration
Currently, the `features-telemetry.js` file uses a `generateMockTelemetry` function. To connect this to your real backend:

1. Create an API endpoint (e.g., `GET /api/features/telemetry`) that returns JSON data in the following format:
   ```json
   [
     {
       "endpoint": "/api/users",
       "method": "GET",
       "hits": 120,
       "avgLatency": 45,
       "p95": 90,
       "p99": 150,
       "errors": 2,
       "lastCalled": "2024-01-01T12:00:00Z"
     }
     // ...
   ]
   ```
2. Modify `features-telemetry.js` to fetch from this endpoint inside the `loadTelemetry` function.

```javascript
/* In features-telemetry.js */
async loadTelemetry(timeRange) {
    this.showLoading(true);
    try {
        const response = await fetch(`/api/features/telemetry?range=${timeRange}`);
        this.data = await response.json();
    } catch (e) {
        console.error("Failed to load telemetry", e);
    }
    // ... rest of the function
}
```
