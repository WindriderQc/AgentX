# Self-Healing Dashboard Documentation

## Overview

The Self-Healing Dashboard provides a comprehensive interface for monitoring and managing automated remediation rules in AgentX. It integrates with the SelfHealingEngine API to provide real-time visibility into rule execution, cooldown timers, and effectiveness metrics.

## Location

- **JavaScript Module**: `/home/yb/codes/AgentX/public/js/self-healing-dashboard.js`
- **HTML Page**: `/home/yb/codes/AgentX/public/self-healing.html`
- **API Routes**: `/home/yb/codes/AgentX/routes/self-healing.js`

## Features

### 1. Rule Management

#### List All Rules
- Display all configured self-healing rules grouped by strategy
- Visual indicators for rule status (enabled/disabled)
- Color-coded by strategy type (failover, rollback, restart, etc.)
- Priority badges (Critical, High, Medium, Low)

#### Enable/Disable Toggles
- Quick toggle switches for each rule
- Instant visual feedback on state changes
- Disabled rules appear with reduced opacity

### 2. Execution History

#### Recent Executions (Last 50)
- Chronological list of rule executions
- Timestamp with "time ago" formatting
- Cooldown status indicators
- Scrollable history panel

#### Rule-Specific History
- View execution history for individual rules
- Detailed execution timestamps
- Success/failure tracking

### 3. Cooldown Timers

#### Real-Time Countdown
- Live cooldown remaining display
- Updates every minute
- Visual indicators:
  - ⏳ Yellow badge: In cooldown
  - ✓ Green badge: Ready to execute

#### Cooldown Information
- Configured cooldown period per rule
- Remaining time in human-readable format (e.g., "5h 23m")
- Automatic re-enabling when cooldown expires

### 4. Rule Parameters Editor

Edit detection and remediation parameters:

**Detection Parameters:**
- Threshold value
- Time window (e.g., "5m", "1h", "24h")
- Comparison operator

**Remediation Parameters:**
- Cooldown period
- Priority (1-4)
- Requires approval flag

### 5. Manual Testing

#### Test Rule Conditions
- Manually trigger rule evaluation
- View test results without executing remediation
- See current metric values vs. thresholds
- Reason why rule would/wouldn't trigger

#### Test Results Display
- Visual success/failure indicators
- Detailed evaluation breakdown
- Option to proceed with execution if triggered

### 6. Manual Execution

#### Execute Remediation
- Manually trigger rule remediation
- Confirmation dialog for safety
- Real-time execution status
- Success/failure notifications

#### Execution Context
- Tracks manual vs. automated triggers
- Records who initiated execution
- Includes metadata in execution log

### 7. Effectiveness Metrics

Per-rule metrics displayed:
- Total execution count
- Success rate percentage
- Last execution timestamp
- Trend indicators

### 8. Dashboard Statistics

Engine-level overview:
- **Engine Status**: Enabled/Disabled indicator
- **Total Rules**: Count of all rules
- **Active Rules**: Enabled rules count
- **Total Executions**: Lifetime execution count
- **In Cooldown**: Rules currently in cooldown
- **Strategies**: Number of unique strategies

### 9. Rule Details View

Comprehensive rule information:
- Full description
- Detection configuration (JSON)
- Remediation configuration (JSON)
- Notification channels
- Additional conditions
- Complete rule JSON export

## API Integration

### Endpoints Used

#### GET /api/self-healing/status
```javascript
// Returns engine status and statistics
{
  enabled: boolean,
  requireApproval: boolean,
  maxConcurrentActions: number,
  rules: {
    total: number,
    enabled: number,
    byStrategy: object,
    byPriority: object
  },
  executions: {
    total: number,
    recentlyExecuted: number,
    availableNow: number
  }
}
```

#### GET /api/self-healing/rules
```javascript
// Returns all rules
{
  status: 'success',
  data: {
    rules: Array<Rule>,
    count: number
  }
}
```

#### GET /api/self-healing/history
```javascript
// Returns execution history
{
  status: 'success',
  data: {
    history: Array<{
      ruleName: string,
      lastExecuted: string,
      cooldownRemaining: number
    }>,
    count: number
  }
}
```

#### GET /api/self-healing/history/:ruleName
```javascript
// Returns history for specific rule
{
  status: 'success',
  data: {
    ruleName: string,
    history: Array<Execution>,
    count: number
  }
}
```

#### POST /api/self-healing/evaluate
```javascript
// Test rule condition
Request: {
  ruleName: string,
  metricsData?: object
}

Response: {
  status: 'success',
  data: {
    rule: string,
    evaluation: {
      shouldTrigger: boolean,
      reason: string,
      currentValue?: number,
      threshold?: number,
      metrics?: object
    }
  }
}
```

#### POST /api/self-healing/execute
```javascript
// Execute rule remediation
Request: {
  ruleName: string,
  context?: object
}

Response: {
  status: 'success',
  data: {
    status: 'success' | 'pending_approval' | 'failed',
    rule: string,
    action: string,
    result?: object,
    error?: string,
    duration: number
  }
}
```

#### POST /api/self-healing/rules/load
```javascript
// Reload rules from config file
Response: {
  status: 'success',
  message: string,
  data: {
    count: number,
    timestamp: string
  }
}
```

## Usage

### Basic Initialization

```javascript
import SelfHealingDashboard from './js/self-healing-dashboard.js';

const dashboard = new SelfHealingDashboard({
  containerId: 'self-healing-container',
  statsContainerId: 'self-healing-stats',
  historyContainerId: 'self-healing-history',
  refreshInterval: 30000 // 30 seconds
});

await dashboard.init();
```

### Custom Configuration

```javascript
const dashboard = new SelfHealingDashboard({
  containerId: 'custom-container-id',
  statsContainerId: 'custom-stats-id',
  historyContainerId: 'custom-history-id',
  refreshInterval: 60000 // 1 minute
});
```

### Manual Actions

```javascript
// Test a rule
await dashboard.testRule('model_slow_response_failover');

// Execute a rule
await dashboard.executeRule('model_slow_response_failover');

// Reload rules from config
await dashboard.reloadRules();

// Evaluate all rules
await dashboard.evaluateAllRules();
```

## UI Components

### Required HTML Structure

```html
<!-- Statistics banner -->
<div id="self-healing-stats"></div>

<!-- Rules list -->
<div id="self-healing-container"></div>

<!-- Execution history -->
<div id="self-healing-history"></div>
```

### Dependencies

- **Bootstrap 5**: UI framework
- **Font Awesome 6**: Icons
- **Toast.js**: Notification system
- **API Client**: HTTP request wrapper

## Rule Strategies

The dashboard supports the following remediation strategies:

| Strategy | Icon | Description |
|----------|------|-------------|
| `model_failover` | 🔄 | Switch to backup Ollama host |
| `prompt_rollback` | ↩️ | Revert to previous prompt version |
| `service_restart` | 🔄 | Restart service via PM2 |
| `throttle_requests` | ⏱️ | Enable rate limiting |
| `alert_only` | 🔔 | Send notifications without action |
| `scale_up` | ⬆️ | Increase resource allocation |

## Priority Levels

| Priority | Label | Color | Use Case |
|----------|-------|-------|----------|
| 1 | Critical | Red | Service down, data loss risk |
| 2 | High | Orange | Performance degradation |
| 3 | Medium | Yellow | Quality issues |
| 4 | Low | Blue | Informational alerts |

## Auto-Refresh

- Dashboard auto-refreshes every 30 seconds (configurable)
- Cooldown timers update every 60 seconds
- Manual refresh available via "Reload" button

## Notifications

The dashboard uses the toast notification system:

- **Success** (Green): Action completed successfully
- **Error** (Red): Action failed
- **Info** (Blue): Informational message
- **Warning** (Yellow): Caution required

## Testing

### Manual Testing Workflow

1. Navigate to Self-Healing Dashboard
2. Locate rule to test
3. Click "Test" button
4. Review evaluation results in modal
5. Optionally execute if conditions met

### Execution Workflow

1. Click "Execute" on rule card
2. Confirm action in dialog
3. Monitor execution status
4. View result notification
5. Check execution history

## Cooldown Management

Rules enforce cooldown periods to prevent remediation loops:

1. **After Execution**: Rule enters cooldown
2. **Cooldown Timer**: Displays remaining time
3. **Actions Disabled**: Test and Execute buttons disabled
4. **Auto-Enable**: Buttons re-enable when cooldown expires

## Error Handling

The dashboard handles various error scenarios:

- **API Unavailable**: Shows error toast, retries on next refresh
- **Invalid Rule**: Displays error message
- **Execution Failed**: Shows failure details
- **Network Error**: Graceful degradation with error messages

## Security Considerations

- **Approval Required**: High-risk actions require confirmation
- **Manual Triggers**: Tracked with user context
- **Audit Trail**: All executions logged
- **Read-Only Views**: Details views are non-destructive

## Customization

### Styling

The dashboard uses Bootstrap 5 classes and can be customized via:
- CSS overrides
- Bootstrap theme variables
- Custom color schemes

### Behavior

Customize via constructor options:
- Refresh interval
- Container IDs
- Display limits

## Browser Compatibility

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

Requires ES6 module support.

## Performance

- **Lazy Loading**: Modals created on-demand
- **Efficient Updates**: Only re-renders changed sections
- **Pagination**: History limited to 50 most recent
- **Debouncing**: Actions debounced to prevent spam

## Future Enhancements

Planned features:

1. **Rule Editor**: Full CRUD operations
2. **Metrics Charts**: Visualization of rule effectiveness
3. **Batch Operations**: Select multiple rules for actions
4. **Export**: Download execution logs as CSV/JSON
5. **Real-Time Updates**: WebSocket integration
6. **Advanced Filters**: Filter rules by tags, priority, status
7. **Custom Dashboards**: User-defined views
8. **Alert Integration**: Link to related alerts

## Troubleshooting

### Dashboard Not Loading

1. Check console for errors
2. Verify API endpoint availability
3. Check authentication status
4. Verify module imports

### Rules Not Appearing

1. Check `/api/self-healing/rules` endpoint
2. Verify rules configuration file
3. Check server logs for errors
4. Reload rules via "Reload" button

### Cooldown Timers Incorrect

1. Verify server time synchronization
2. Check execution history accuracy
3. Reload page to refresh state

### Actions Not Working

1. Verify API endpoints are accessible
2. Check authentication/authorization
3. Review server logs for errors
4. Confirm rule is enabled and not in cooldown

## Related Documentation

- [Self-Healing Quick Start](./SELF_HEALING_QUICK_START.md)
- [API Routes Implementation](./API_ROUTES_IMPLEMENTATION.md)
- [Alert Dashboard](./ALERTS_DASHBOARD.md)
- [SelfHealingEngine Service](../src/services/selfHealingEngine.js)

## Support

For issues or questions:
1. Check server logs: `pm2 logs agentx`
2. Review browser console
3. Consult API documentation
4. Contact development team
