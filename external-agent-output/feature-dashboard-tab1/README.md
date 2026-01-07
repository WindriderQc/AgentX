# Feature Inventory Tab Integration Guide

This component provides a matrix view of feature alignment across Frontend, Backend, Documentation, and Roadmap.

## Files

- `features-inventory.html` - The main HTML structure (and demo page).
- `features-inventory.js` - Mock data and logic (rendering, filtering, sorting).
- `features-inventory.css` - Styles for the dashboard.

## Integration

1. **Include CSS**:
   Add the following to your main dashboard page `<head>` or import into your main CSS file:
   ```html
   <link rel="stylesheet" href="path/to/features-inventory.css">
   ```

2. **Include Container**:
   Place the `.dashboard-container` div from `features-inventory.html` into your main content area.

3. **Include JS**:
   Add the script at the end of your `<body>`:
   ```html
   <script src="path/to/features-inventory.js" type="module"></script>
   ```

## API Endpoints (Future)

Currently, the `features-inventory.js` file uses `MOCK_DATA`. When the backend is ready, replace the mock data logic in `loadInventory()` and `scanCodebase()` with calls to:

- `GET /api/features/inventory` - Returns the list of features.
- `POST /api/features/inventory/scan` - Triggers a real-time codebase scan.

## Customization

- **Categories**: Modify the `<select id="categoryFilter">` in the HTML and the `MOCK_DATA` in JS to match your actual feature categories.
- **Statuses**: The `renderOverallStatus` and `renderRoadmapBadge` functions in JS define the color logic for statuses.
