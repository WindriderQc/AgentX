# Alert Analytics Dashboard

## Overview

The Alert Analytics Dashboard provides comprehensive visualization and insights into your alert data, helping you identify trends, patterns, and areas for improvement in your monitoring system.

## Features

### 1. Key Metrics
- **Total Alerts**: Total number of alerts in the selected time period
- **Critical Alerts**: Count of critical severity alerts
- **MTTA (Mean Time To Acknowledge)**: Average time between alert creation and acknowledgment
- **MTTR (Mean Time To Resolution)**: Average time between alert creation and resolution

### 2. Alert Volume Over Time
Line chart showing alert trends over time, broken down by severity:
- Critical (red)
- High (orange)
- Warning (yellow)
- Info (gray)

Helps identify:
- Alert spikes
- Time-based patterns
- Severity distribution trends

### 3. Alerts by Severity
Doughnut chart showing the distribution of alerts by severity level.

Use this to:
- Understand overall system health
- Identify if too many alerts are critical
- Balance alert severity thresholds

### 4. Top Alerting Components
Horizontal bar chart displaying the top 10 components/sources generating alerts.

Helps identify:
- Problem areas in your system
- Components needing attention
- Noisy alert sources

### 5. Alert Status Distribution
Bar chart showing alerts by status:
- Active (requires attention)
- Acknowledged (being worked on)
- Resolved (completed)
- Suppressed (temporarily muted)

### 6. Delivery Success Rate by Channel
Bar chart showing the success rate (percentage) for each alert delivery channel:
- Email
- Slack
- Webhook
- DataAPI

Use this to:
- Monitor notification reliability
- Identify channel issues
- Optimize alert routing

### 7. Alert Recurrence Heatmap
Visual heatmap showing when alerts occur:
- X-axis: Hour of day (0-23)
- Y-axis: Day of week (Sunday-Saturday)
- Color intensity: Number of alerts

Helps identify:
- Time-based alert patterns
- Scheduled job issues
- Business hours vs off-hours patterns

## Usage

### Accessing the Dashboard

Navigate to: `http://your-domain/alert-analytics.html`

Or from the Alerts Dashboard, click the "Analytics" link.

### Time Range Selection

Use the dropdown in the top-right to select different time periods:
- Last 24 hours
- Last 7 days (default)
- Last 14 days
- Last 30 days
- Last 90 days

The dashboard automatically adjusts the time granularity:
- 24 hours: Hourly buckets
- 7-30 days: Daily buckets
- 90 days: Daily buckets with date aggregation

### Refresh Data

Click the "Refresh" button to manually update all charts with the latest data.

Auto-refresh occurs every 60 seconds by default.

## API Endpoint

The dashboard fetches data from:

```
GET /api/alerts/statistics?from=<ISO_DATE>&to=<ISO_DATE>
```

### Request Parameters

- `from` (required): ISO 8601 date string for start of range
- `to` (optional): ISO 8601 date string for end of range (defaults to now)

### Response Structure

```json
{
  "status": "success",
  "data": {
    "summary": {
      "totalAlerts": 1234,
      "activeAlerts": 45,
      "acknowledgedAlerts": 12,
      "resolvedAlerts": 1177,
      "avgResolutionTime": 3600000,
      "avgAcknowledgmentTime": 300000
    },
    "bySeverity": {
      "critical": 89,
      "high": 234,
      "warning": 567,
      "info": 344
    },
    "byStatus": {
      "active": 45,
      "acknowledged": 12,
      "resolved": 1177
    },
    "bySource": {
      "component-a": 456,
      "component-b": 234,
      "component-c": 123
    },
    "byRule": [
      {
        "_id": "high-cpu-usage",
        "count": 145,
        "avgOccurrences": 2.3
      }
    ],
    "deliveryStats": [
      {
        "_id": "email",
        "sent": 890,
        "failed": 10
      }
    ],
    "timeSeries": [
      {
        "_id": {
          "year": 2026,
          "month": 1,
          "day": 2,
          "hour": 14
        },
        "count": 23,
        "critical": 2,
        "high": 5,
        "warning": 10,
        "info": 6
      }
    ],
    "heatmap": [
      {
        "_id": {
          "dayOfWeek": 2,
          "hour": 14
        },
        "count": 45
      }
    ],
    "generatedAt": "2026-01-02T20:30:00.000Z"
  }
}
```

## Implementation Details

### Files

#### Frontend
- `/public/alert-analytics.html` - Dashboard HTML page
- `/public/js/alert-analytics.js` - JavaScript module with Chart.js visualizations

#### Backend
- `/routes/alerts.js` - Includes `/api/alerts/statistics` endpoint
- `/models/Alert.js` - Alert model with aggregation support

### Dependencies

- **Chart.js v4.4.4**: Charting library
- **Font Awesome 6.4.0**: Icons
- **Space Grotesk**: Font family

### Technology Stack

- **Frontend**: Vanilla JavaScript ES6 modules
- **Backend**: Express.js with MongoDB aggregation pipeline
- **Database**: MongoDB with efficient aggregation queries

## Optimization Tips

### For Better Performance

1. **Use Appropriate Time Ranges**: Longer ranges fetch more data
2. **Index Alerts**: Ensure MongoDB indexes on `createdAt`, `severity`, `status`, `source`
3. **Limit Data**: The endpoint automatically limits component results to top 20

### Recommended MongoDB Indexes

```javascript
db.alerts.createIndex({ createdAt: -1 });
db.alerts.createIndex({ severity: 1, status: 1 });
db.alerts.createIndex({ source: 1, createdAt: -1 });
db.alerts.createIndex({ "resolution.resolved": 1, "resolution.resolvedAt": 1 });
db.alerts.createIndex({ "acknowledgment.acknowledged": 1, "acknowledgment.acknowledgedAt": 1 });
```

## Customization

### Modify Refresh Interval

In `alert-analytics.html`, change:

```javascript
const analytics = new AlertAnalytics({
    refreshInterval: 30000  // Change to desired milliseconds
});
```

### Change Color Scheme

In `alert-analytics.js`, modify the `colors` object:

```javascript
this.colors = {
    critical: '#your-color',
    warning: '#your-color',
    // etc...
};
```

### Add Custom Metrics

1. Extend the aggregation pipeline in `/routes/alerts.js`
2. Add new metric card in HTML layout
3. Update `updateMetrics()` method in JavaScript

## Troubleshooting

### Charts Not Rendering

1. Check browser console for errors
2. Verify Chart.js is loaded: `console.log(Chart)`
3. Check API endpoint is accessible: `/api/alerts/statistics`

### No Data Displayed

1. Verify alerts exist in database
2. Check time range selection
3. Review MongoDB query filters

### Slow Performance

1. Add recommended indexes
2. Reduce time range
3. Check MongoDB server performance
4. Consider data archival strategy

## Best Practices

1. **Regular Monitoring**: Check dashboard daily to identify trends
2. **Alert Tuning**: Use component charts to identify noisy sources
3. **Response Times**: Monitor MTTA/MTTR to improve incident response
4. **Capacity Planning**: Use volume trends for resource planning
5. **Delivery Reliability**: Ensure high success rates on critical channels

## Future Enhancements

Potential additions:
- Export charts as images
- Scheduled PDF reports
- Alert forecasting with ML
- Anomaly detection
- Custom date range picker
- Alert correlation analysis
- Real-time WebSocket updates
- Comparative period analysis
- Alert storm detection

## Support

For issues or questions:
1. Check logs in browser console
2. Review server logs for API errors
3. Verify MongoDB connection and indexes
4. Consult API documentation in `/docs/API_ROUTES_IMPLEMENTATION.md`

## Related Documentation

- [API Routes Implementation](./API_ROUTES_IMPLEMENTATION.md)
- [Alert Service Documentation](../src/services/README.md)
- [Alert Model Schema](../models/Alert.js)
