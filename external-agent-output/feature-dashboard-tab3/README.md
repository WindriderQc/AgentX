# Feature Adoption Tracking Guide

This guide explains how to implement feature tracking in the codebase so that data appears in the Feature Adoption Dashboard (Tab 3).

## 1. Concept

We track feature usage by events:
- **Feature Access**: Visits to specific pages.
- **Feature Interaction**: Clicks on key buttons (e.g., "Run Report", "Upload File").
- **Feature Completion**: Successful API responses for key actions.

## 2. Implementation

### A. Add Tracking Attribute

The simplest way to track a UI element is adding the `data-feature` attribute.

```html
<!-- Example: Button in features.html -->
<button 
    class="btn btn-primary" 
    data-feature="rag-upload" 
    onclick="uploadFile()">
    Upload Document
</button>
```

### B. Global Tracking Script

Ensure this script is loaded in your main layout (e.g., `layout.html` or `index.html`):

```javascript
// feature-tracker.js
document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-feature]');
    if (target) {
        const featureId = target.dataset.feature;
        trackFeatureUsage(featureId, 'click');
    }
});

function trackFeatureUsage(featureId, actionType) {
    // Send to backend (fire and forget)
    // In production, this would be a POST to /api/features/usage
    console.log(`[Feature Tracked] ${featureId} (${actionType})`);
    
    /* 
    fetch('/api/features/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            feature: featureId,
            action: actionType,
            timestamp: new Date().toISOString()
        })
    });
    */
}
```

### C. Page View Tracking

For features that map 1:1 to a page, track on load:

```javascript
// In specific page script
document.addEventListener('DOMContentLoaded', () => {
    trackFeatureUsage('audit-logs-page', 'view');
});
```

## 3. Backend Integration (Future)

The dashboard expects the API to return aggregated metrics. The backend aggregator should:
1. Validates the `featureId` against the Feature Inventory (Tab 1).
2. Stores the event in a time-series DB or simple collection `feature_usage`.
3. Aggregates daily for the dashboard.

## 4. Local Testing

1. Open `features-adoption.html` in your browser.
2. The mock data generator will populate the dashboard.
3. Use the filters (Time Range, Category) to see how the dashboard behaves.
