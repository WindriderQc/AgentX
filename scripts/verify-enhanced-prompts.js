#!/usr/bin/env node

const mongoose = require('mongoose');
require('dotenv').config();

const BenchmarkPrompt = require('../models/BenchmarkPrompt');

async function verifyPrompts() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✓ Connected to MongoDB\n');

    // Get all prompts
    const allPrompts = await BenchmarkPrompt.find().sort({ category: 1, level: 1 });
    console.log(`Total prompts in database: ${allPrompts.length}\n`);

    // Count by category
    const categoryCount = {};
    allPrompts.forEach(p => {
      categoryCount[p.category] = (categoryCount[p.category] || 0) + 1;
    });

    console.log('='.repeat(60));
    console.log('PROMPTS BY CATEGORY:');
    console.log('='.repeat(60));

    const originalCategories = ['coding', 'reasoning', 'factual', 'math', 'creative', 'general'];
    const enhancedCategories = ['instruction-following', 'summarization', 'translation', 'multi-turn-reasoning', 'context-retention', 'edge-cases'];

    console.log('\nOriginal Categories:');
    originalCategories.forEach(cat => {
      const count = categoryCount[cat] || 0;
      console.log(`  - ${cat.padEnd(25)}: ${count.toString().padStart(3)} prompts`);
    });

    console.log('\nEnhanced Categories (NEW):');
    enhancedCategories.forEach(cat => {
      const count = categoryCount[cat] || 0;
      console.log(`  - ${cat.padEnd(25)}: ${count.toString().padStart(3)} prompts`);
    });

    // Count by level
    const levelCount = {};
    allPrompts.forEach(p => {
      levelCount[p.level] = (levelCount[p.level] || 0) + 1;
    });

    console.log('\n' + '='.repeat(60));
    console.log('PROMPTS BY LEVEL:');
    console.log('='.repeat(60));
    for (let i = 1; i <= 10; i++) {
      const count = levelCount[i] || 0;
      const bar = '█'.repeat(Math.floor(count / 2));
      console.log(`  Level ${i.toString().padStart(2)}: ${count.toString().padStart(3)} prompts ${bar}`);
    }

    // Count by scoring_type
    const scoringCount = {};
    allPrompts.forEach(p => {
      scoringCount[p.scoring_type] = (scoringCount[p.scoring_type] || 0) + 1;
    });

    console.log('\n' + '='.repeat(60));
    console.log('PROMPTS BY SCORING TYPE:');
    console.log('='.repeat(60));
    Object.keys(scoringCount).sort().forEach(type => {
      console.log(`  - ${type.padEnd(25)}: ${scoringCount[type].toString().padStart(3)} prompts`);
    });

    // Sample some enhanced category prompts
    console.log('\n' + '='.repeat(60));
    console.log('SAMPLE ENHANCED PROMPTS:');
    console.log('='.repeat(60));

    for (const cat of enhancedCategories.slice(0, 3)) {
      const sample = await BenchmarkPrompt.findOne({ category: cat }).sort({ level: 1 });
      if (sample) {
        console.log(`\n[${cat}] ${sample.name} (Level ${sample.level})`);
        console.log(`  Prompt: ${sample.prompt.substring(0, 80)}...`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✓ INTEGRATION COMPLETE');
    console.log('='.repeat(60));
    console.log(`✓ ${allPrompts.length} total prompts in database`);
    console.log(`✓ ${enhancedCategories.filter(c => categoryCount[c] > 0).length} enhanced categories integrated`);
    console.log(`✓ Ready for model testing`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
  }
}

verifyPrompts();
