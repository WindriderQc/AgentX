/**
 * Prompt Sampling
 * Selection and sampling of benchmark prompts by depth and category
 */

/**
 * Group an array by a key function
 */
function groupBy(arr, keyFn) {
    const groups = {};
    for (const item of arr) {
        const key = typeof keyFn === 'function' ? keyFn(item) : item[keyFn];
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
    }
    return groups;
}

/**
 * Pick N random items from an array (Fisher-Yates partial shuffle)
 */
function randomPick(arr, n) {
    if (n >= arr.length) return [...arr];
    const copy = [...arr];
    for (let i = copy.length - 1; i > copy.length - 1 - n; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(copy.length - n);
}

/**
 * Sample prompts according to depth configuration
 * Groups prompts by level, then samples per-category for balanced coverage
 */
function samplePromptsByDepth(prompts, depthConfig) {
    const byLevel = groupBy(prompts, 'level');
    const sampled = [];

    for (const [level, levelPrompts] of Object.entries(byLevel)) {
        const depth = depthConfig[level] || depthConfig[String(level)] || 'off';
        if (depth === 'off') continue;
        if (depth === 'full') {
            sampled.push(...levelPrompts);
            continue;
        }

        if (depth === 'single') {
            sampled.push(randomPick(levelPrompts, 1)[0]);
            continue;
        }

        const byCategory = groupBy(levelPrompts, 'category');

        if (depth === 'light') {
            for (const catPrompts of Object.values(byCategory)) {
                sampled.push(randomPick(catPrompts, 1)[0]);
            }
        } else if (depth === 'half') {
            for (const catPrompts of Object.values(byCategory)) {
                const n = Math.max(1, Math.ceil(catPrompts.length / 2));
                sampled.push(...randomPick(catPrompts, n));
            }
        }
    }

    return sampled;
}

/**
 * Enforce balanced category coverage by selecting the same number of prompts per category.
 * Default behavior uses the smallest category size (strict matrix).
 */
function sampleBalancedByCategory(prompts) {
    const safePrompts = Array.isArray(prompts) ? prompts : [];
    if (safePrompts.length === 0) return [];

    const byCategory = groupBy(safePrompts, (p) => (p && p.category) ? p.category : 'uncategorized');
    const categories = Object.keys(byCategory);
    if (categories.length <= 1) return [...safePrompts];

    const counts = categories.map((category) => byCategory[category].length);
    const minCount = Math.min(...counts);

    const target = Math.max(0, minCount);
    if (target === 0) return [];

    const balanced = [];
    for (const category of categories) {
        balanced.push(...randomPick(byCategory[category], target));
    }

    return balanced;
}

module.exports = { groupBy, randomPick, samplePromptsByDepth, sampleBalancedByCategory };
