# A/B Testing Configuration Guide

This guide explains how to use the A/B Testing Configuration Panel for prompt management in AgentX.

## Overview

The A/B Testing Configuration Panel allows you to:
- Configure traffic distribution across multiple prompt versions
- Activate/deactivate specific versions
- Visualize traffic distribution in real-time
- Validate configuration before saving

## Accessing the Panel

1. Navigate to the Prompt Management page (`/prompts.html`)
2. Find the prompt you want to configure
3. Click the **"A/B Test"** button on the prompt card

## Features

### Traffic Weight Configuration

Each active version can be assigned a traffic weight (0-100%). The panel displays:
- **Version information** (version number, description)
- **Performance metrics** (impressions, positive rate)
- **Traffic weight slider** and numeric input
- **Active/Inactive toggle** for each version

### Weight Distribution Validation

The panel ensures configuration validity:
- ✅ **Total weight must equal 100%** for active versions
- ✅ **At least one version must be active**
- ❌ Save button is disabled until validation passes
- ⚠️ Warning message displays if constraints are violated

### Real-Time Visualization

The traffic distribution chart shows:
- **Bar chart** with color-coded segments for each active version
- **Legend** showing version number and weight percentage
- **Visual feedback** updated in real-time as you adjust sliders

### Bulk Actions

Quick configuration tools:
- **Activate All** - Activates all versions
- **Deactivate All** - Deactivates all versions
- **Equal Distribution** - Distributes traffic equally among active versions
- **Reset** - Reverts to original configuration

## Configuration Workflow

### Step 1: Select Versions

1. Open the A/B Test Configuration Panel
2. Review the list of available versions
3. Check/uncheck versions to activate/deactivate them

**Tip:** Use "Show inactive versions" toggle to see all versions, including inactive ones.

### Step 2: Set Traffic Weights

1. Use the **slider** for coarse adjustments
2. Use the **numeric input** for precise values
3. Watch the **distribution chart** update in real-time
4. Check the **total weight** indicator (must equal 100%)

**Example:** For a 50/50 A/B test between v1 and v2:
- v1: 50%
- v2: 50%
- Total: 100% ✅

### Step 3: Validate Configuration

Before saving, ensure:
- ✅ Total weight = 100%
- ✅ At least one version is active
- ✅ No validation warnings displayed

### Step 4: Save Configuration

1. Click **"Save Configuration"** button
2. Wait for success notification
3. Prompt list refreshes with updated weights

## Common Scenarios

### Scenario 1: Gradual Rollout

**Goal:** Test a new prompt version with limited traffic before full rollout.

**Configuration:**
- v1 (stable): 90% traffic
- v2 (new): 10% traffic

**Steps:**
1. Open A/B test panel for the prompt
2. Ensure both v1 and v2 are active
3. Set v1 weight to 90
4. Set v2 weight to 10
5. Save configuration

### Scenario 2: Champion/Challenger Test

**Goal:** Compare two competing prompt designs equally.

**Configuration:**
- v3 (champion): 50% traffic
- v4 (challenger): 50% traffic

**Steps:**
1. Open A/B test panel
2. Deactivate older versions (v1, v2)
3. Activate v3 and v4
4. Use "Equal Distribution" button
5. Save configuration

### Scenario 3: Multi-Variant Test

**Goal:** Test three variants with different weights based on confidence.

**Configuration:**
- v1 (baseline): 40% traffic
- v2 (variant A): 30% traffic
- v3 (variant B): 30% traffic

**Steps:**
1. Open A/B test panel
2. Activate all three versions
3. Set v1 to 40%, v2 to 30%, v3 to 30%
4. Verify total = 100%
5. Save configuration

### Scenario 4: Return to Single Version

**Goal:** After testing, use only the winning version.

**Configuration:**
- v2 (winner): 100% traffic
- All other versions: Inactive

**Steps:**
1. Open A/B test panel
2. Deactivate all versions except v2
3. Set v2 weight to 100
4. Save configuration

## Best Practices

### Traffic Distribution

- **Start conservative:** Begin with 10-20% traffic for new versions
- **Equal split for true A/B:** Use 50/50 for unbiased comparison
- **Gradual rollout:** Increase winning version's traffic incrementally

### Version Management

- **Keep versions meaningful:** Don't activate too many versions at once (2-3 max recommended)
- **Monitor metrics:** Check performance before adjusting weights
- **Document changes:** Use version descriptions to explain differences

### Testing Strategy

1. **Baseline period:** Run single version to establish baseline metrics
2. **Test period:** Introduce A/B test with new version(s)
3. **Analysis:** Compare metrics (positive rate, impressions)
4. **Decision:** Roll out winner or iterate on challenger
5. **Cleanup:** Deactivate losing versions

## Keyboard Shortcuts

- **ESC** - Close panel without saving
- **Tab** - Navigate between weight inputs
- **Enter** (on numeric input) - Update value and move to next

## Troubleshooting

### Issue: Save button is disabled

**Causes:**
- Total weight ≠ 100%
- No versions are active

**Solution:**
- Check validation warning message
- Adjust weights to sum to 100%
- Ensure at least one version is active

### Issue: Slider not moving

**Cause:** Version is inactive

**Solution:** Check the version's active toggle first

### Issue: Changes not reflected in prompt list

**Cause:** Configuration saved but list not refreshed

**Solution:**
- Refresh the page manually
- Check browser console for errors
- Verify network connectivity

## API Integration

The A/B Test Configuration Panel uses the following API endpoint:

```
POST /api/prompts/:name/ab-test
```

**Request Body:**
```json
{
  "versions": [
    { "version": 1, "weight": 50 },
    { "version": 2, "weight": 50 }
  ]
}
```

**Response:**
```json
{
  "status": "success",
  "message": "A/B test configured",
  "data": {
    "abTestGroup": "ab_test_1704096000000",
    "versions": [...]
  }
}
```

## Technical Details

### Weight Validation

- Weights must be integers between 0-100
- Sum of active version weights must equal 100
- Inactive versions can have any weight (ignored in distribution)

### Distribution Algorithm

The backend uses **proportional random selection**:

1. Calculate total weight of active versions
2. Generate random number (0-100)
3. Select version based on cumulative weight ranges

**Example:**
- v1: 30% → range [0-30)
- v2: 70% → range [30-100)

Random 45 → selects v2

### Stats Tracking

Each version tracks:
- **Impressions**: Number of times selected
- **Positive count**: Positive feedback received
- **Negative count**: Negative feedback received
- **Positive rate**: `positiveCount / (positiveCount + negativeCount)`

## Related Documentation

- [Prompt Management Guide](./prompt-management.md)
- [Analytics Dashboard](./analytics.md)
- [API Reference](/docs/api/reference.md#prompts)

## Support

For issues or questions:
- Check [GitHub Issues](https://github.com/your-org/agentx/issues)
- Contact development team
- Review [CLAUDE.md](/CLAUDE.md) for architecture details
