# Debug: Persona Rendering Issue

## Problem
Console shows:
```
Loaded 13 personas
```
But personas not appearing in "Choose an Agent" section.

## Root Cause
Timing issue - personas were trying to render before agent cards were loaded, or not finding the correct container element.

## Fix Applied

### Enhanced persona-selector.js with:

1. **Better Timing Detection**
```javascript
const checkAndRender = () => {
  const agentCards = launcherGrid.querySelectorAll('.agentx-card');
  console.log(`Found ${agentCards.length} agent cards, rendering ${personas.length} personas`);

  if (agentCards.length > 0 || Date.now() - startTime > 2000) {
    // Agents loaded or timeout - render personas
    renderPersonasInLauncher(launcherGrid);
  } else {
    // Check again in 200ms
    setTimeout(checkAndRender, 200);
  }
};
```

2. **Debug Logging**
- ✅ Log when launcher grid is found
- ✅ Log agent card count before rendering
- ✅ Log persona count being rendered
- ✅ Log after successful render
- ✅ Warn if container not found

3. **Excluded Personas Logging**
```javascript
console.log(`Loaded ${personas.length} personas (excluded: ${excludedPersonas.join(', ')})`);
```

## How to Debug

### Open Browser Console
After refreshing http://localhost:3080/index.html, you should see:

**Expected Console Output:**
```
Loaded 13 personas (excluded: manual_override)
Found launcher grid, waiting for agents to load...
Found 6 agent cards, rendering 13 personas
✓ Rendered 13 persona cards into launcher
```

**If you see:**
```
Agent launcher grid not found
```
→ Element ID `agentxLauncherGrid` doesn't exist or isn't loaded yet

**If you see:**
```
Found 0 agent cards, rendering 13 personas
✓ Rendered 13 persona cards into launcher
```
→ Personas rendering before agents, but should still appear

**If you see:**
```
No persona cards to render
```
→ All personas filtered out or persona card HTML generation failed

## Manual Verification Steps

1. **Open DevTools Console**
2. **Refresh page**
3. **Check console for:**
   - Persona load count
   - Launcher grid detection
   - Agent card count
   - Render confirmation

4. **Inspect DOM:**
   ```javascript
   document.querySelectorAll('#agentxLauncherGrid .persona-card')
   ```
   Should return 13 NodeList items

5. **Check if personas excluded:**
   ```javascript
   window.PersonaSelector.loadPersonas().then(p => console.log(p.length))
   ```

## Common Issues

### Issue 1: Container Not Found
**Symptom:** "Agent launcher grid not found"
**Fix:** Ensure `#agentxLauncherGrid` exists in HTML
**Check:** `document.getElementById('agentxLauncherGrid')`

### Issue 2: Rendering Too Early
**Symptom:** Personas render but don't show
**Fix:** Increased timeout and added polling
**Check:** Look for agent cards first

### Issue 3: All Personas Excluded
**Symptom:** "Loaded 0 personas"
**Fix:** Check excludedPersonas list
**Check:** Remove manual_override from exclude list temporarily

### Issue 4: CSS Not Styling Cards
**Symptom:** Cards render but look broken
**Fix:** Check .persona-card CSS classes
**Check:** Inspect element styles in DevTools

## Files Modified

- `/public/js/persona-selector.js` - Added debug logging + timing fix
- Console should now show detailed rendering steps

## Next Steps

1. Refresh browser
2. Check console output
3. If still not showing:
   - Screenshot console logs
   - Screenshot HTML inspector of #agentxLauncherGrid
   - Check if agents themselves are showing
