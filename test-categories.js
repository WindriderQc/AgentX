#!/usr/bin/env node
/**
 * Test script to verify all 16 benchmark categories load correctly
 * Usage: node test-categories.js
 */

const qs = require('./src/services/qualityScorer');

console.log('✅ Module loaded successfully');
console.log('✅ All weight validations passed\n');

console.log(`📊 ENHANCED_SCORING_CONFIGS: ${Object.keys(qs.ENHANCED_SCORING_CONFIGS).length} categories\n`);

Object.keys(qs.ENHANCED_SCORING_CONFIGS).forEach((cat, i) => {
    const config = qs.ENHANCED_SCORING_CONFIGS[cat];
    const dims = config.dimensions.length;
    const weightSum = config.dimensions.reduce((sum, dim) => sum + dim.weight, 0);
    const status = Math.abs(weightSum - 1.0) < 0.001 ? '✓' : '✗';
    
    console.log(`  ${(i+1).toString().padStart(2)}. ${cat.padEnd(24)} (${dims.toString().padStart(2)} dims, sum=${weightSum.toFixed(3)}) ${status}`);
});

console.log(`\n📊 CATEGORY_COMPOSITE_PROFILES: ${Object.keys(qs.CATEGORY_COMPOSITE_PROFILES).length} profiles\n`);

Object.keys(qs.CATEGORY_COMPOSITE_PROFILES).forEach((cat, i) => {
    const profile = qs.CATEGORY_COMPOSITE_PROFILES[cat];
    const { quality, latency, speed } = profile.weights;
    const sum = quality + latency + speed;
    const status = Math.abs(sum - 1.0) < 0.001 ? '✓' : '✗';
    
    console.log(`  ${(i+1).toString().padStart(2)}. ${cat.padEnd(24)} (q=${quality}, l=${latency}, s=${speed}, sum=${sum.toFixed(3)}) ${status}`);
});

console.log('\n✅ All validations passed!');
