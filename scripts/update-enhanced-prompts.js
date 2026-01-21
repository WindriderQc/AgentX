#!/usr/bin/env node

/**
 * Update Enhanced Benchmark Prompts
 *
 * Compares existing prompts in the database with the updated JSON file
 * and updates any prompts where the content has changed.
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BenchmarkPrompt = require('../models/BenchmarkPrompt');

const promptsFile = path.join(__dirname, '../data/benchmark-prompts-enhanced.json');

async function updateEnhancedPrompts(dryRun = false) {
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

    const newPrompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
    console.log(`✓ Loaded ${newPrompts.length} prompts from file\n`);

    let checked = 0;
    let updated = 0;
    let unchanged = 0;
    let notFound = 0;

    console.log('Checking for updates...\n');

    for (let i = 0; i < newPrompts.length; i++) {
      const newPrompt = newPrompts[i];
      checked++;

      // Find existing prompt in database
      const dbPrompt = await BenchmarkPrompt.findOne({
        name: newPrompt.name,
        category: newPrompt.category
      });

      if (!dbPrompt) {
        console.log(`  [${i + 1}/${newPrompts.length}] NOT FOUND: "${newPrompt.name}" (${newPrompt.category})`);
        notFound++;
        continue;
      }

      // Check if content differs
      const fieldsToCompare = ['prompt', 'expected_answer', 'scoring_type', 'level'];
      let hasChanges = false;
      const changes = [];

      for (const field of fieldsToCompare) {
        if (JSON.stringify(dbPrompt[field]) !== JSON.stringify(newPrompt[field])) {
          hasChanges = true;
          changes.push(field);
        }
      }

      if (hasChanges) {
        if (dryRun) {
          console.log(`  [${i + 1}/${newPrompts.length}] WOULD UPDATE: "${newPrompt.name}" (${newPrompt.category})`);
          console.log(`    Changed fields: ${changes.join(', ')}`);
        } else {
          // Update the prompt
          dbPrompt.prompt = newPrompt.prompt;
          dbPrompt.expected_answer = newPrompt.expected_answer;
          dbPrompt.scoring_type = newPrompt.scoring_type;
          dbPrompt.level = newPrompt.level;

          await dbPrompt.save();
          console.log(`  [${i + 1}/${newPrompts.length}] ✓ UPDATED: "${newPrompt.name}" (${newPrompt.category})`);
          console.log(`    Changed fields: ${changes.join(', ')}`);
        }
        updated++;
      } else {
        unchanged++;
        if ((i + 1) % 20 === 0) {
          console.log(`  [${i + 1}/${newPrompts.length}] Progress: ${unchanged} unchanged so far...`);
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('UPDATE SUMMARY:');
    console.log('='.repeat(60));
    console.log(`Total prompts checked: ${checked}`);
    console.log(`${dryRun ? 'Would update' : 'Updated'}:     ${updated}`);
    console.log(`Unchanged:             ${unchanged}`);
    console.log(`Not found in DB:       ${notFound}`);

    if (updated > 0) {
      console.log(`\n${dryRun ? '✓ Dry run complete - run without --dry-run to apply updates' : '✓ Updates applied successfully'}`);
    } else {
      console.log('\n✓ All prompts are already up to date');
    }

  } catch (error) {
    console.error('✗ Update failed:', error);
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

// Run the update
updateEnhancedPrompts(dryRun);
