# Performance Metrics Dashboard Component

## Overview

The Performance Metrics Dashboard is a real-time analytics component that displays prompt performance metrics at a glance. It integrates with the Analytics API to fetch feedback data and presents it in an intuitive, card-based interface.

## Location

- **Component:** `/public/js/components/PerformanceMetricsDashboard.js`
- **Styles:** `/public/css/prompts.css` (sections: `.metrics-dashboard`)
- **Integration:** `/public/prompts.html` - mounted in `#metricsDashboard` container
- **Tests:** `/tests/components/PerformanceMetricsDashboard.test.js`

## Features

### 1. Real-Time Metrics Display
- **Total Feedback:** Count of all feedback (positive + negative)
- **Positive Rate:** Percentage of positive feedback
- **Positive/Negative Breakdown:** Detailed counts
- **Version Count:** Number of versions per prompt
- **Visual Feedback Bar:** Color-coded progress bar showing positive vs negative ratio

### 2. Time Range Filtering
- Last 7 days (default)
- Last 30 days
- Last 90 days
- All time

### 3. Auto-Refresh
- Optional 30-second auto-refresh
- Manual refresh button
- Spinning icon indicates active loading

### 4. Health Status Classification
- **Good (Green):** Positive rate >= 70%
- **Caution (Yellow):** Positive rate 50-70%
- **Poor (Red):** Positive rate < 50%

### 5. Collapsible UI
- Collapse/expand toggle
- Maintains collapsed state
- Saves screen space

### 6. Interactive Cards
- Click card to view detailed analytics
- "Details" button links to Analytics page with filter
- Hover effects for better UX

## Architecture

### ES6 Class Structure

```javascript
export class PerformanceMetricsDashboard {
  constructor(containerId, state)
  init()
  render()
  attachEventListeners()
  loadMetrics()
  renderMetrics()
  aggregateByPromptName(breakdown)
  renderMetricCard(promptName, data)
  // ... helper methods
}
```

### State Management

The component receives shared app state:
```javascript
state = {
  prompts: {},  // Current prompts data
  filters: {}   // Active filters
}
```

### API Integration

Fetches data from:
```
GET /api/analytics/feedback?from={ISO_DATE}&to={ISO_DATE}&groupBy=promptVersion
```

**Response Format:**
```json
{
  "status": "success",
  "data": {
    "from": "2025-12-25T00:00:00.000Z",
    "to": "2026-01-01T00:00:00.000Z",
    "totalFeedback": 150,
    "positive": 110,
    "negative": 40,
    "positiveRate": 0.733,
    "breakdown": [
      {
        "promptName": "default_chat",
        "promptVersion": 2,
        "total": 75,
        "positive": 60,
        "negative": 15,
        "positiveRate": 0.8
      }
    ]
  }
}
```

## Usage

### Initialization

In `/public/js/prompts.js`:

```javascript
import { PerformanceMetricsDashboard } from './components/PerformanceMetricsDashboard.js';

// Initialize
metricsDashboard = new PerformanceMetricsDashboard('metricsDashboard', state);
```

### HTML Container

In `/public/prompts.html`:

```html
<!-- Performance Metrics Dashboard -->
<div id="metricsDashboard"></div>
```

## CSS Styling

### Key Classes

- `.metrics-dashboard` - Main container
- `.dashboard-header` - Header with controls
- `.metrics-grid` - Responsive card grid
- `.metric-card` - Individual metric card
- `.metric-card.good/caution/poor` - Status-based styling
- `.feedback-bar` - Visual progress bar
- `.status-badge` - Health status indicator

### Responsive Breakpoints

- **Desktop:** 3-column grid (320px min width)
- **Tablet (1024px):** 2-column grid (280px min width)
- **Mobile (768px):** Single column, stacked layout

### Color Palette

- **Good:** `rgb(52, 211, 153)` (green)
- **Caution:** `rgb(251, 191, 36)` (yellow)
- **Poor:** `rgb(248, 113, 113)` (red)
- **Accent:** `rgb(124, 240, 255)` (cyan)

## Error Handling

### Graceful Degradation

1. **API Unavailable:** Shows error message with retry option
2. **No Data:** Displays empty state with helpful message
3. **Loading State:** Spinner with loading text
4. **Auto-refresh Errors:** Silently logs, continues normal operation

### Empty States

```html
<div class="metrics-empty">
  <i class="fas fa-chart-line"></i>
  <p>No metrics available for the selected time range</p>
  <small>Metrics will appear once prompts are used and receive feedback</small>
</div>
```

## Performance Considerations

### Optimizations

1. **Debounced Refresh:** 30-second intervals (not too aggressive)
2. **Conditional Rendering:** Only re-renders on data change
3. **Lazy Loading:** Loads on mount, not before
4. **Cleanup:** Properly destroys interval timers

### Data Aggregation

Aggregates multiple prompt versions into single cards:
- Sums total feedback across versions
- Calculates weighted positive rate
- Groups by prompt name for cleaner display

## Testing

### Test Coverage

11 unit tests covering:
- Data aggregation logic
- Positive rate calculation
- Date range calculations
- Status classification
- Number formatting
- HTML escaping

Run tests:
```bash
npm test -- --testPathPattern=PerformanceMetricsDashboard
```

## Future Enhancements

### Potential Improvements

1. **Trending Indicators:** Show up/down arrows based on historical comparison
2. **Sparkline Charts:** Mini charts showing feedback trends over time
3. **Export Functionality:** Download metrics as CSV/JSON
4. **Custom Thresholds:** User-configurable good/caution/poor boundaries
5. **Real-time Updates:** WebSocket integration for live updates
6. **Drill-down Filters:** Click version count to filter prompt list

## Integration Points

### Connected Components

- **PromptsAPI:** Fetches analytics data
- **PromptListView:** Can be filtered based on metrics
- **Toast:** Shows error/success notifications
- **Analytics Page:** Links for detailed views

### Event Flow

```
User Action → Component State → API Call → Data Transform → Render
     ↓
Auto-refresh (optional) → Repeat every 30s
```

## Browser Compatibility

- **Modern Browsers:** Full support (Chrome, Firefox, Safari, Edge)
- **ES6 Modules:** Required
- **Fetch API:** Required
- **CSS Grid:** Required

## Accessibility

### Features

- Semantic HTML structure
- ARIA labels on interactive elements
- Keyboard navigation support (tab, enter)
- Color contrast meets WCAG AA standards
- Screen reader friendly

## Maintenance

### Code Style

- ES6 class syntax
- JSDoc comments for public methods
- Consistent naming conventions
- DRY principles applied

### Dependencies

- None (vanilla JavaScript)
- Relies on existing app state management
- Uses native Fetch API

## Changelog

### v1.0.0 (2026-01-01)
- Initial implementation
- Real-time metrics display
- Auto-refresh capability
- Time range filtering
- Health status classification
- Responsive design
- Empty/error state handling

## Support

For issues or questions, refer to:
- `/docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md` - API documentation
- `/specs/V4_ANALYTICS_ARCHITECTURE.md` - Analytics architecture
- `/CLAUDE.md` - Development guidelines
