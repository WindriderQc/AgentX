# Benchmark Color Theme System

## Overview

The benchmark page uses a **level-based color theme system** where each test level (1-5) has its own distinct color gradient. This creates a cohesive visual hierarchy across all benchmark visualizations including stars, progress bars, badges, and timeline segments.

**Key Principle**: Color is determined by **test level** (1-5), while opacity/intensity is determined by **test count** (3-100+).

---

## Test Level Color Themes

### Level 1: Red/Orange Gradient
**Purpose**: Basic difficulty tests
**Primary Use**: Star 1, Level 1 progress bars

```css
/* Red/Orange - Entry Level */
--theme-level-1-from: #dc2626
--theme-level-1-to: #f87171
--theme-level-1-glow: rgba(220, 38, 38, 0.4)
```

**Applied To**:
- Star position 1 (leftmost star in ranking)
- Progress bar when executing Level 1 tests
- Level 1 badges: `L1`

---

### Level 2: Green/Emerald Gradient
**Purpose**: Easy-to-moderate difficulty tests
**Primary Use**: Star 2, Level 2 progress bars

```css
/* Green/Emerald - Intermediate */
--theme-high-from: #10b981
--theme-high-to: #34d399
--theme-high-glow: rgba(16, 185, 129, 0.5)
```

**Applied To**:
- Star position 2
- Progress bar when executing Level 2 tests
- Level 2 badges: `L2`
- Success timeline segments (uses green→cyan blend)

---

### Level 3: Yellow/Amber Gradient
**Purpose**: Moderate difficulty tests
**Primary Use**: Star 3, Level 3 progress bars

```css
/* Yellow/Amber - Moderate */
--theme-mid-from: #f59e0b
--theme-mid-to: #fbbf24
--theme-mid-glow: rgba(245, 158, 11, 0.5)
```

**Applied To**:
- Star position 3
- Progress bar when executing Level 3 tests
- Level 3 badges: `L3`
- Running timeline segments (pulsing yellow animation)

---

### Level 4: Blue/Cyan Gradient
**Purpose**: Advanced difficulty tests
**Primary Use**: Star 4, Level 4 progress bars

```css
/* Blue/Cyan - Advanced */
--theme-veryhigh-from: #06b6d4
--theme-veryhigh-to: #22d3ee
--theme-veryhigh-glow: rgba(6, 182, 212, 0.6)
```

**Applied To**:
- Star position 4
- Progress bar when executing Level 4 tests
- Level 4 badges: `L4`
- Heatmap scores 80-100% (excellence indicator)

---

### Level 5: Gold Gradient
**Purpose**: Expert/maximum difficulty tests
**Primary Use**: Star 5, Level 5 progress bars

```css
/* Gold - Expert Level */
--theme-ultra-from: #ffd700
--theme-ultra-to: #ffed4e
--theme-ultra-glow: rgba(255, 215, 0, 0.7)
```

**Applied To**:
- Star position 5 (rightmost star)
- Progress bar when executing Level 5 tests
- Level 5 badges: `L5`
- Ultra stars with 100+ tests get **golden pulse animation**

---

## Star Rendering System

### Two-Dimensional System

Stars use a **two-dimensional** visual encoding:

1. **Color (X-axis)**: Determined by **level position** (1-5)
2. **Intensity (Y-axis)**: Determined by **test count** (3-100+)

### Star Color Classes

```css
/* Level-based color assignment */
.test-star.test-star-level-1 { /* Red gradient */ }
.test-star.test-star-level-2 { /* Green gradient */ }
.test-star.test-star-level-3 { /* Yellow gradient */ }
.test-star.test-star-level-4 { /* Blue/Cyan gradient */ }
.test-star.test-star-level-5 { /* Gold gradient */ }
```

### Star Intensity Classes

```css
/* Count-based intensity modifiers */
.test-star.intensity-low       { opacity: 0.5; }  /* 3-9 tests */
.test-star.intensity-mid       { opacity: 0.75; } /* 10-24 tests */
.test-star.intensity-high      { opacity: 0.9; }  /* 25-49 tests */
.test-star.intensity-veryhigh  { opacity: 1.0; }  /* 50-99 tests */
.test-star.intensity-ultra     { opacity: 1.0; animation: golden-pulse; } /* 100+ tests */
```

### Star HTML Structure

```html
<!-- Example: Level 3 star with 50 tests -->
<span class="test-star test-star-level-3 intensity-veryhigh">
    <i class="fas fa-star"></i>
</span>
<span class="test-star-count">50</span>
```

**Visual Result**: Yellow/amber gradient star at 100% opacity with moderate glow

---

## Progress Bar Color System

Progress bars **dynamically change color** based on the current test's level during execution.

### Implementation

**File**: `public/benchmark.html` (lines 5262-5287)

```javascript
const getLevelGradient = (level) => {
    switch (Number(level)) {
        case 1: return 'linear-gradient(90deg, #dc2626 0%, #f87171 100%)'; // Red
        case 2: return 'linear-gradient(90deg, #10b981 0%, #34d399 100%)'; // Green
        case 3: return 'linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%)'; // Yellow
        case 4: return 'linear-gradient(90deg, #06b6d4 0%, #22d3ee 100%)'; // Blue/Cyan
        case 5: return 'linear-gradient(90deg, #ffd700 0%, #ffed4e 100%)'; // Gold
        default: return 'linear-gradient(90deg, var(--accent), rgba(238, 176, 255, 0.8))';
    }
};

// Apply to execution progress bar
execFill.style.background = getLevelGradient(batch.current_test.prompt_level);
```

**Behavior**:
- Progress bar color updates in real-time as tests execute
- Level 1 test → Red progress bar
- Level 5 test → Gold progress bar
- Creates visual feedback showing what difficulty level is currently being tested

---

## Level Badges

Level badges (e.g., `L1`, `L2`, `L3`) display inline with test indicators.

### Badge Styling Function

**File**: `public/benchmark.html` (lines 5330-5341)

```javascript
const getLevelBadgeStyle = (level) => {
    switch (Number(level)) {
        case 1: return 'background: rgba(220, 38, 38, 0.2); color: #f87171;'; // Red
        case 2: return 'background: rgba(16, 185, 129, 0.2); color: #34d399;'; // Green
        case 3: return 'background: rgba(245, 158, 11, 0.2); color: #fbbf24;'; // Yellow
        case 4: return 'background: rgba(6, 182, 212, 0.2); color: #22d3ee;'; // Blue/Cyan
        case 5: return 'background: rgba(255, 215, 0, 0.2); color: #ffed4e;'; // Gold
    }
};
```

**Usage**:
```html
<span style="${getLevelBadgeStyle(3)} padding: 2px 8px; border-radius: 12px;">L3</span>
```

**Visual Result**: Semi-transparent background with bright text matching the level's theme color

---

## Heatmap Color System

Performance heatmaps use themed gradients to indicate quality scores.

### Heatmap Color Function

**File**: `public/benchmark.html` (lines 7783-7796)

```javascript
const getHeatColor = (value, reverse = false) => {
    if (reverse) value = 100 - value;
    if (value >= 80) return 'linear-gradient(135deg, #06b6d4 0%, #22d3ee 100%)'; // Blue/Cyan
    if (value >= 60) return 'linear-gradient(135deg, #10b981 0%, #34d399 100%)'; // Green
    if (value >= 40) return 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)'; // Yellow
    if (value >= 20) return 'linear-gradient(135deg, #f97316 0%, #fb923c 100%)'; // Orange
    return 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)'; // Red
};
```

**Mapping**:
- 80-100% → Blue/Cyan (Level 4 theme - excellence)
- 60-80% → Green (Level 2 theme - good)
- 40-60% → Yellow (Level 3 theme - moderate)
- 20-40% → Orange (warning)
- 0-20% → Red (Level 1 theme - poor)

---

## Timeline Segments

Timeline visualization uses themed gradients for test execution status.

### Segment Classes

**File**: `public/benchmark.html` (lines 172-224)

```css
/* Success segments: Green→Cyan blend */
.segment-success {
    background: linear-gradient(135deg, var(--theme-high-from) 0%, var(--theme-veryhigh-to) 100%);
    box-shadow: 0 2px 8px var(--theme-high-glow);
}

/* Running segments: Yellow/Amber with pulse */
.segment-running {
    background: linear-gradient(135deg, var(--theme-mid-from) 0%, var(--theme-mid-to) 100%);
    animation: pulse-gradient 2s ease-in-out infinite;
}

/* Error segments: Red gradient */
.segment-error {
    background: linear-gradient(135deg, #dc2626 0%, #ef4444 100%);
}

/* Judging segments: Purple (distinct from test levels) */
.segment-judging {
    background: linear-gradient(135deg, #a855f7 0%, #c084fc 100%);
}
```

---

## Star Rendering Logic

### JavaScript Implementation

**File**: `public/benchmark.html` (lines 6731-6765)

```javascript
// Get intensity class based on test count
const getIntensityClass = (count) => {
    const n = Number(count || 0);
    if (n >= 100) return 'intensity-ultra';
    if (n >= 50) return 'intensity-veryhigh';
    if (n >= 25) return 'intensity-high';
    if (n >= 10) return 'intensity-mid';
    if (n >= 3) return 'intensity-low';
    return '';
};

// Build stars HTML - each star gets level-based color + count-based intensity
const starsHtml = [1, 2, 3, 4, 5].map((level) => {
    const count = Number(levelStats[level] ?? 0);
    if (count <= 0) {
        return '<span class="test-star-slot" aria-hidden="true"></span>';
    }
    const levelClass = `test-star-level-${level}`;
    const intensityClass = getIntensityClass(count);
    return `
        <span class="test-star-slot" title="Level ${level}: ${count} tests">
            <span class="test-star ${levelClass} ${intensityClass}">
                <i class="fas fa-star"></i>
            </span>
            <span class="test-star-count">${count}</span>
        </span>
    `;
}).join('');
```

### Example Output

**Scenario**: Model has run tests at all 5 levels with varying counts

```
Level 1: 5 tests   → Red star, low intensity (50% opacity)
Level 2: 30 tests  → Green star, high intensity (90% opacity)
Level 3: 15 tests  → Yellow star, mid intensity (75% opacity)
Level 4: 75 tests  → Blue/Cyan star, veryhigh intensity (100% opacity)
Level 5: 120 tests → Gold star, ultra intensity (100% + pulse animation)
```

---

## CSS Custom Properties

### Theme Variable Definitions

**File**: `public/benchmark.html` (lines 958-983)

```css
:root {
    /* Low (Gray/Silver) - Used for low-intensity modifiers */
    --theme-low-from: #9ca3af;
    --theme-low-to: #d1d5db;
    --theme-low-glow: rgba(156, 163, 175, 0.4);

    /* Mid (Yellow/Amber) - Level 3 */
    --theme-mid-from: #f59e0b;
    --theme-mid-to: #fbbf24;
    --theme-mid-glow: rgba(245, 158, 11, 0.5);

    /* High (Green/Emerald) - Level 2 */
    --theme-high-from: #10b981;
    --theme-high-to: #34d399;
    --theme-high-glow: rgba(16, 185, 129, 0.5);

    /* VeryHigh (Blue/Cyan) - Level 4 */
    --theme-veryhigh-from: #06b6d4;
    --theme-veryhigh-to: #22d3ee;
    --theme-veryhigh-glow: rgba(6, 182, 212, 0.6);

    /* Ultra (Gold) - Level 5 */
    --theme-ultra-from: #ffd700;
    --theme-ultra-to: #ffed4e;
    --theme-ultra-glow: rgba(255, 215, 0, 0.7);
}
```

---

## Golden Pulse Animation

Stars with 100+ tests at Level 5 get a special golden pulse animation.

### Animation Definition

**File**: `public/benchmark.html` (lines 1099-1114)

```css
@keyframes golden-pulse {
    0%, 100% {
        transform: scale(1);
        filter:
            drop-shadow(0 0 8px var(--theme-ultra-glow))
            drop-shadow(0 0 14px rgba(255, 215, 0, 0.5))
            drop-shadow(0 0 22px rgba(255, 237, 78, 0.35));
    }
    50% {
        transform: scale(1.05);
        filter:
            drop-shadow(0 0 12px var(--theme-ultra-glow))
            drop-shadow(0 0 18px rgba(255, 215, 0, 0.6))
            drop-shadow(0 0 28px rgba(255, 237, 78, 0.45));
    }
}
```

**Triggered When**:
- Star is at Level 5 (gold gradient)
- Test count is 100 or more
- Class applied: `test-star-level-5 intensity-ultra`

---

## Visual Hierarchy Summary

### By Level (Color)
1. **Level 1**: Red/Orange - Entry-level tests
2. **Level 2**: Green/Emerald - Intermediate tests
3. **Level 3**: Yellow/Amber - Moderate tests
4. **Level 4**: Blue/Cyan - Advanced tests
5. **Level 5**: Gold - Expert tests

### By Count (Intensity)
- **3-9 tests**: Low intensity (50% opacity, desaturated)
- **10-24 tests**: Mid intensity (75% opacity)
- **25-49 tests**: High intensity (90% opacity)
- **50-99 tests**: Very high intensity (100% opacity)
- **100+ tests**: Ultra intensity (100% opacity + pulse animation)

### Applied Across
- ✅ Star rankings (5 stars per model)
- ✅ Progress bars (dynamic based on current test)
- ✅ Level badges (`L1`, `L2`, `L3`, etc.)
- ✅ Performance heatmaps
- ✅ Timeline segments
- ✅ Current test indicators

---

## Design Rationale

### Why Level-Based Colors?

1. **Semantic Meaning**: Each difficulty level has a consistent visual identity
2. **Predictability**: Users learn that "yellow = Level 3" across all contexts
3. **Scalability**: System supports 5 distinct levels with clear hierarchy
4. **Accessibility**: High contrast gradients ensure visibility

### Why Separate Intensity Modifiers?

1. **Information Density**: Encodes two variables (level + count) in one visual element
2. **Progressive Disclosure**: Low test counts appear muted; high counts are vibrant
3. **Motivational Feedback**: More tests = brighter stars (gamification)
4. **Reduces Clutter**: Avoids needing 25+ color variations (5 levels × 5 intensities)

---

## Browser Compatibility

### Gradient Text (Background Clip)

```css
background: linear-gradient(...);
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
background-clip: text;
```

**Support**: Chrome 120+, Firefox 49+, Safari 14+, Edge 120+
**Fallback**: Stars will display in solid color if `background-clip: text` is unsupported

### Filter Drop Shadow

```css
filter: drop-shadow(0 0 10px rgba(...));
```

**Support**: All modern browsers (Chrome 18+, Firefox 35+, Safari 9+, Edge 12+)

---

## Future Enhancements

### Potential Additions

1. **User-Customizable Themes**: Allow users to define their own level color palettes
2. **Colorblind Modes**: Alternative color schemes optimized for different types of color vision deficiency
3. **Dark/Light Mode Variants**: Adjust saturation and brightness based on theme
4. **Animation Intensity Preferences**: Toggle off pulse animations for accessibility
5. **Level 6-10 Support**: Extend color palette if more difficulty levels are added

---

## Related Documentation

- **[Benchmark System](./BENCHMARK_SYSTEM.md)**: Overall benchmark architecture
- **[Testing Patterns](../patterns/TESTING_PATTERNS.md)**: How tests are categorized by level
- **[User Manual - Benchmark Page](../user-manual/README.md#benchmark-page)**: End-user guide

---

## Changelog

### 2026-01-10
- **Initial Implementation**: Level-based color theme system
- Added 5 distinct level gradients (Red, Green, Yellow, Blue, Gold)
- Implemented two-dimensional star encoding (level × count)
- Dynamic progress bar colors based on current test level
- Themed level badges with semi-transparent backgrounds
- Golden pulse animation for ultra-high test counts (100+)
