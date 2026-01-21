#!/usr/bin/env node

/**
 * Seed Enhanced Benchmark Prompts
 *
 * Loads 120 new benchmark prompts across 6 enhanced categories:
 * - instruction-following
 * - summarization
 * - translation
 * - multi-turn-reasoning
 * - context-retention
 * - edge-cases
 *
 * Each category has 20 prompts distributed across levels 1-10
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BenchmarkPrompt = require('../models/BenchmarkPrompt');

// Load prompts from JSON file
const promptsFile = path.join(__dirname, '../data/benchmark-prompts-enhanced.json');

async function seedEnhancedPrompts(dryRun = false) {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✓ Connected to MongoDB');

    // Read prompts file
    if (!fs.existsSync(promptsFile)) {
      console.error(`✗ Prompts file not found: ${promptsFile}`);
      process.exit(1);
    }

    const prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
    console.log(`✓ Loaded ${prompts.length} prompts from file`);

    // Validate required fields
    const requiredFields = ['level', 'category', 'category_test', 'name', 'prompt', 'expected_tokens', 'expected_answer', 'judge_criteria', 'scoring_type'];
    let validationErrors = 0;

    prompts.forEach((prompt, index) => {
      const missing = requiredFields.filter(field => !(field in prompt));
      if (missing.length > 0) {
        console.error(`✗ Prompt ${index} (${prompt.name || 'unknown'}) missing fields: ${missing.join(', ')}`);
        validationErrors++;
      }
    });

    if (validationErrors > 0) {
      console.error(`\n✗ Validation failed with ${validationErrors} errors`);
      process.exit(1);
    }

    console.log('✓ All prompts passed validation');

    // Check for existing prompts by name + category
    console.log('\nChecking for duplicates...');
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];

      // Check if prompt already exists
      const existing = await BenchmarkPrompt.findOne({
        name: prompt.name,
        category: prompt.category
      });

      if (existing) {
        console.log(`  [${i + 1}/${prompts.length}] SKIP: "${prompt.name}" (${prompt.category}) - already exists`);
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`  [${i + 1}/${prompts.length}] DRY RUN: Would insert "${prompt.name}" (${prompt.category}, level ${prompt.level})`);
        inserted++;
      } else {
        try {
          // Insert new prompt
          await BenchmarkPrompt.create({
            name: prompt.name,
            prompt: prompt.prompt,
            level: prompt.level,
            category: prompt.category,
            expected_answer: prompt.expected_answer,
            scoring_type: prompt.scoring_type,
            custom: false
          });

          console.log(`  [${i + 1}/${prompts.length}] ✓ Inserted: "${prompt.name}" (${prompt.category}, level ${prompt.level})`);
          inserted++;
        } catch (err) {
          console.error(`  [${i + 1}/${prompts.length}] ✗ Error inserting "${prompt.name}": ${err.message}`);
          errors++;
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SEEDING SUMMARY:');
    console.log('='.repeat(60));
    console.log(`Total prompts in file: ${prompts.length}`);
    console.log(`${dryRun ? 'Would insert' : 'Inserted'}:  ${inserted}`);
    console.log(`Skipped (duplicates): ${skipped}`);
    if (errors > 0) {
      console.log(`Errors:               ${errors}`);
    }

    // Show category distribution
    const categoryCount = {};
    prompts.forEach(p => {
      categoryCount[p.category] = (categoryCount[p.category] || 0) + 1;
    });

    console.log('\nCategory Distribution:');
    Object.keys(categoryCount).sort().forEach(cat => {
      console.log(`  - ${cat}: ${categoryCount[cat]} prompts`);
    });

    // Show level distribution
    const levelCount = {};
    prompts.forEach(p => {
      levelCount[p.level] = (levelCount[p.level] || 0) + 1;
    });

    console.log('\nLevel Distribution:');
    for (let i = 1; i <= 10; i++) {
      const count = levelCount[i] || 0;
      console.log(`  - Level ${i.toString().padStart(2)}: ${count} prompts`);
    }

    console.log('\n' + (dryRun ? '✓ Dry run complete' : '✓ Seeding complete'));

  } catch (error) {
    console.error('✗ Seeding failed:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n✓ Database connection closed');
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-d');

if (dryRun) {
  console.log('Running in DRY RUN mode (no changes will be made)\n');
}

// Run the seeding
seedEnhancedPrompts(dryRun);
