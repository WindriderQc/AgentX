# Self-Healing Dashboard - Quick Reference

## Quick Start

```javascript
import SelfHealingDashboard from './js/self-healing-dashboard.js';

const dashboard = new SelfHealingDashboard();
await dashboard.init();
```

## API Endpoints Cheat Sheet

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/self-healing/status` | GET | Engine status & stats |
| `/api/self-healing/rules` | GET | List all rules |
| `/api/self-healing/rules/:name` | GET | Get specific rule |
| `/api/self-healing/history` | GET | All execution history |
| `/api/self-healing/history/:name` | GET | Rule-specific history |
| `/api/self-healing/evaluate` | POST | Test rule condition |
| `/api/self-healing/execute` | POST | Execute remediation |
| `/api/self-healing/rules/load` | POST | Reload configuration |

## Dashboard Methods

```javascript
// Load data
await dashboard.loadStatus();
await dashboard.loadRules();
await dashboard.loadHistory();

// Actions
await dashboard.testRule(ruleName);
await dashboard.executeRule(ruleName);
await dashboard.editRule(ruleName);
await dashboard.viewRuleDetails(ruleName);
await dashboard.viewRuleHistory(ruleName);
await dashboard.reloadRules();
await dashboard.evaluateAllRules();

// Control
dashboard.startAutoRefresh();
dashboard.stopAutoRefresh();
dashboard.destroy();
```

## Rule Strategies

| Strategy | Use Case | Approval Required |
|----------|----------|-------------------|
| `model_failover` | Ollama host issues | No |
| `prompt_rollback` | Quality degradation | No |
| `service_restart` | Service down | Yes |
| `throttle_requests` | Cost control | Yes |
| `alert_only` | Monitoring only | No |
| `scale_up` | Resource exhaustion | Yes |

## Priority Levels

| Level | Label | Color | Use For |
|-------|-------|-------|---------|
| 1 | Critical | Red | Service outages |
| 2 | High | Orange | Performance issues |
| 3 | Medium | Yellow | Quality problems |
| 4 | Low | Blue | Informational |

## Rule Configuration Template

```json
{
  "name": "my_rule_name",
  "enabled": true,
  "description": "Rule description",
  "detectionQuery": {
    "metric": "error_rate",
    "aggregation": "avg",
    "threshold": 0.05,
    "comparison": "greater_than",
    "window": "15m",
    "componentType": "agentx",
    "componentPattern": "*"
  },
  "remediation": {
    "strategy": "alert_only",
    "action": "send_alert",
    "automated": true,
    "requiresApproval": false,
    "cooldown": "30m",
    "priority": 3
  },
  "notifications": {
    "onTrigger": ["slack", "email"],
    "onSuccess": ["slack"],
    "onFailure": ["slack", "email"]
  },
  "tags": ["monitoring"]
}
```

## Time Window Formats

- `5s` - 5 seconds
- `5m` - 5 minutes
- `1h` - 1 hour
- `24h` - 24 hours
- `7d` - 7 days

## Comparison Operators

- `greater_than` - Value > Threshold
- `less_than` - Value < Threshold
- `equal` - Value === Threshold
- `greater_or_equal` - Value >= Threshold
- `less_or_equal` - Value <= Threshold

## Aggregation Methods

- `avg` - Average value
- `sum` - Total sum
- `max` - Maximum value
- `min` - Minimum value
- `count` - Count of occurrences

## HTML Structure

```html
<!-- Required containers -->
<div id="self-healing-stats"></div>
<div id="self-healing-container"></div>
<div id="self-healing-history"></div>

<!-- Initialize -->
<script type="module">
  import SelfHealingDashboard from './js/self-healing-dashboard.js';
  window.selfHealingDashboard = new SelfHealingDashboard();
  await window.selfHealingDashboard.init();
</script>
```

## Common Tasks

### Add a New Rule

1. Edit `/config/self-healing-rules.json`
2. Add rule configuration
3. Call `POST /api/self-healing/rules/load`
4. Dashboard auto-refreshes

### Test a Rule

```javascript
await dashboard.testRule('rule_name');
// View results in modal
```

### Execute Remediation

```javascript
await dashboard.executeRule('rule_name');
// Confirmation required
// Result shown in toast
```

### View Cooldown Status

```javascript
const cooldown = dashboard.getCooldownInfo(rule);
console.log(cooldown.remainingText); // "5h 23m"
```

## Troubleshooting

### Dashboard not loading?
1. Check browser console for errors
2. Verify API endpoints accessible: `curl http://localhost:3000/api/self-healing/status`
3. Check authentication status
4. Verify module imports

### Rules not appearing?
1. Check rules file: `/config/self-healing-rules.json`
2. Verify rules loaded: `GET /api/self-healing/rules`
3. Check `enabled: true` in rule config
4. Click "Reload" button in dashboard

### Cooldown not working?
1. Verify execution recorded in history
2. Check cooldown period in rule config
3. Reload page to refresh state
4. Check server time synchronization

### Cannot execute rule?
1. Check rule is enabled
2. Verify not in cooldown
3. Check approval requirements
4. Review server logs for errors

## Keyboard Shortcuts

None currently implemented. Planned for future release.

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

Requires ES6 module support and fetch API.

## Performance Tips

1. **Adjust refresh interval** for lower traffic:
   ```javascript
   new SelfHealingDashboard({ refreshInterval: 60000 }); // 1 minute
   ```

2. **Limit history display**:
   - Dashboard shows last 50 executions
   - Older entries available via API

3. **Disable auto-refresh** when not actively monitoring:
   ```javascript
   dashboard.stopAutoRefresh();
   ```

## Security Notes

- All actions require authentication
- Critical actions require approval
- Manual triggers logged with user context
- No sensitive data in localStorage

## Links

- **Full Documentation**: [SELF_HEALING_DASHBOARD.md](./SELF_HEALING_DASHBOARD.md)
- **Architecture**: [SELF_HEALING_ARCHITECTURE.md](./SELF_HEALING_ARCHITECTURE.md)
- **Quick Start**: [SELF_HEALING_QUICK_START.md](./SELF_HEALING_QUICK_START.md)
- **API Routes**: [../routes/self-healing.js](../routes/self-healing.js)
- **Engine Service**: [../src/services/selfHealingEngine.js](../src/services/selfHealingEngine.js)

## Example Workflows

### Workflow 1: Monitor and Test
1. Load dashboard
2. Review rules list
3. Check cooldown timers
4. Test suspicious rule
5. Review test results
6. Execute if needed

### Workflow 2: Add and Validate Rule
1. Edit rules.json
2. Click "Reload" in dashboard
3. Verify rule appears
4. Test rule condition
5. Execute manually
6. Monitor history

### Workflow 3: Investigate Failed Execution
1. View history panel
2. Click rule name
3. Review execution log
4. Check rule details
5. Test condition again
6. Adjust parameters if needed

## Code Snippets

### Custom Initialization
```javascript
const dashboard = new SelfHealingDashboard({
  containerId: 'my-container',
  statsContainerId: 'my-stats',
  historyContainerId: 'my-history',
  refreshInterval: 45000 // 45 seconds
});
```

### Manual Refresh
```javascript
// Refresh all data
await dashboard.loadStatus();
await dashboard.loadRules();
await dashboard.loadHistory();
```

### Filter Rules by Strategy
```javascript
const rules = dashboard.rules.filter(r =>
  r.remediation.strategy === 'model_failover'
);
```

### Get Rules in Cooldown
```javascript
const inCooldown = dashboard.executionHistory.filter(h =>
  h.cooldownRemaining > 0
);
```

### Export Rules to JSON
```javascript
const json = JSON.stringify(dashboard.rules, null, 2);
console.log(json);
// Copy from console or save to file
```

## Environment Variables

```bash
# Enable/disable self-healing
SELF_HEALING_ENABLED=true

# Require approval for critical actions
REQUIRE_APPROVAL=true

# Max concurrent remediation actions
MAX_CONCURRENT_ACTIONS=3
```

## Common Patterns

### Pattern: Batch Testing
```javascript
for (const rule of dashboard.rules) {
  const result = await dashboard.testRule(rule.name);
  console.log(`${rule.name}: ${result.shouldTrigger}`);
}
```

### Pattern: Filter by Priority
```javascript
const critical = dashboard.rules.filter(r =>
  r.remediation.priority === 1
);
```

### Pattern: Check if Ready to Execute
```javascript
const canExecute = (rule) => {
  const cooldown = dashboard.getCooldownInfo(rule);
  return rule.enabled && !cooldown.inCooldown;
};
```

## Version History

- **v1.0** (2026-01-03): Initial release
  - All 6 core features implemented
  - API integration complete
  - Documentation complete

## Support

For issues or questions:
1. Check this reference guide
2. Review full documentation
3. Check browser console for errors
4. Review server logs: `pm2 logs agentx`
5. Contact development team

---

**Quick Reference v1.0** | Last Updated: 2026-01-03
