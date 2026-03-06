#!/usr/bin/env node
/**
 * Audit Benchmark Prompt Coverage
 * Reports prompt counts per category × level and identifies gaps.
 *
 * Usage: node scripts/audit-prompt-coverage.js [--min N]
 *   --min N   Minimum prompts per category×level (default: 5)
 */

const MIN_PER_LEVEL = parseInt(process.argv.find(a => a.startsWith('--min='))?.split('=')[1], 10)
    || (process.argv.includes('--min') ? parseInt(process.argv[process.argv.indexOf('--min') + 1], 10) : 5)
    || 5;

const base = require('../data/benchmark-prompts.json');
const enhanced = require('../data/benchmark-prompts-enhanced.json');
const deep = require('../data/benchmark-prompts-deep.json');
const { GENERALIST_CATEGORY_WEIGHTS } = require('../config/categories');

const all = [...base, ...enhanced, ...deep];
console.log(`Total prompts: ${all.length} (base: ${base.length}, enhanced: ${enhanced.length}, deep: ${deep.length})`);
console.log(`Minimum per level: ${MIN_PER_LEVEL}\n`);

// Build category × level grid
const grid = {};
const allLevels = new Set();
for (const p of all) {
    const cat = p.category || 'unknown';
    const level = p.level || 0;
    allLevels.add(level);
    if (!grid[cat]) grid[cat] = {};
    grid[cat][level] = (grid[cat][level] || 0) + 1;
}

const levels = [...allLevels].sort((a, b) => a - b);

// Print grid
const catWidth = 25;
const colWidth = 5;
const header = 'Category'.padEnd(catWidth) + 'Total'.padStart(colWidth + 1) + levels.map(l => `L${l}`.padStart(colWidth)).join('') + '  Gaps';
console.log(header);
console.log('-'.repeat(header.length + 10));

let totalGaps = 0;
const gapDetails = [];

const sortedCats = Object.keys(GENERALIST_CATEGORY_WEIGHTS);
// Add any categories in prompts but not in weights
for (const cat of Object.keys(grid)) {
    if (!sortedCats.includes(cat)) sortedCats.push(cat);
}

for (const cat of sortedCats) {
    const counts = grid[cat] || {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const weight = GENERALIST_CATEGORY_WEIGHTS[cat];
    const weightStr = weight ? ` (${(weight * 100).toFixed(0)}%)` : '';

    let gaps = 0;
    const gapLevels = [];
    const levelCols = levels.map(l => {
        const count = counts[l] || 0;
        if (count < MIN_PER_LEVEL) {
            gaps++;
            totalGaps++;
            gapLevels.push({ level: l, have: count, need: MIN_PER_LEVEL - count });
        }
        const marker = count < MIN_PER_LEVEL ? '*' : ' ';
        return `${String(count).padStart(colWidth - 1)}${marker}`;
    }).join('');

    const gapFlag = gaps > 0 ? `  ${gaps} gaps` : '';
    console.log(`${(cat + weightStr).padEnd(catWidth)}${String(total).padStart(colWidth + 1)}${levelCols}${gapFlag}`);

    if (gapLevels.length > 0) {
        gapDetails.push({ category: cat, weight, gaps: gapLevels });
    }
}

console.log(`\n${'*'.padStart(1)} = below minimum (${MIN_PER_LEVEL})`);
console.log(`\nTotal gaps: ${totalGaps} (category x level combinations needing more prompts)`);

if (gapDetails.length > 0) {
    // Sort by weight descending — highest-impact gaps first
    gapDetails.sort((a, b) => (b.weight || 0) - (a.weight || 0));

    console.log('\n=== Priority Fill Order (by category weight) ===\n');
    let totalNeeded = 0;
    for (const { category, weight, gaps } of gapDetails) {
        const needed = gaps.reduce((sum, g) => sum + g.need, 0);
        totalNeeded += needed;
        console.log(`${category} (${weight ? (weight * 100).toFixed(0) + '%' : 'unweighted'}): need ${needed} more prompts`);
        for (const g of gaps) {
            console.log(`    L${g.level}: have ${g.have}, need +${g.need}`);
        }
    }
    console.log(`\nTotal prompts needed to reach minimum: ${totalNeeded}`);
}

// Metadata quality
let missingCriteria = 0, missingDeterministic = 0;
const deterministicCategories = ['math', 'coding', 'factual'];
for (const p of all) {
    if (!p.judge_criteria || p.judge_criteria.length === 0) missingCriteria++;
    if (deterministicCategories.includes(p.category) && !p.deterministic_scoring) missingDeterministic++;
}
console.log(`\nMetadata quality:`);
console.log(`  Missing judge_criteria: ${missingCriteria}/${all.length}`);
console.log(`  Missing deterministic_scoring (math/coding/factual): ${missingDeterministic}`);
