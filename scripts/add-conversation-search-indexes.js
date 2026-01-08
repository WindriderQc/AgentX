#!/usr/bin/env node
/**
 * Migration Script: Add Conversation Search Indexes
 *
 * This script safely adds text and compound indexes to the Conversation collection
 * for the enhanced search and filtering feature (V7).
 *
 * What it does:
 * 1. Connects to MongoDB
 * 2. Checks for existing indexes
 * 3. Creates new indexes:
 *    - Text index on title and messages.content (for full-text search)
 *    - Compound indexes for filtering (model, date, RAG, feedback, tags)
 * 4. Reports on success/failures
 *
 * Usage:
 *   node scripts/add-conversation-search-indexes.js
 *
 * Environment:
 *   Requires MONGODB_URI to be set
 */

require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../config/logger');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Index definitions to create
const INDEXES_TO_CREATE = [
  {
    name: 'conversation_text_search',
    spec: {
      title: 'text',
      'messages.content': 'text'
    },
    options: {
      weights: {
        title: 10,
        'messages.content': 5
      },
      name: 'conversation_text_search'
    },
    description: 'Text index for full-text search on title and messages'
  },
  {
    name: 'workspace_user_tags',
    spec: { workspaceId: 1, userId: 1, tags: 1 },
    options: { name: 'workspace_user_tags' },
    description: 'Compound index for workspace + user + tags filtering'
  },
  {
    name: 'workspace_user_model_date',
    spec: { workspaceId: 1, userId: 1, model: 1, createdAt: -1 },
    options: { name: 'workspace_user_model_date' },
    description: 'Compound index for workspace + user + model + date filtering'
  },
  {
    name: 'workspace_user_rag_date',
    spec: { workspaceId: 1, userId: 1, ragUsed: 1, createdAt: -1 },
    options: { name: 'workspace_user_rag_date' },
    description: 'Compound index for workspace + user + RAG + date filtering'
  },
  {
    name: 'workspace_user_feedback',
    spec: { workspaceId: 1, userId: 1, 'messages.feedback.rating': 1 },
    options: { name: 'workspace_user_feedback' },
    description: 'Compound index for workspace + user + feedback filtering'
  }
];

async function getExistingIndexes(collection) {
  try {
    const indexes = await collection.indexes();
    return indexes.map(idx => idx.name);
  } catch (error) {
    logger.error('Failed to get existing indexes', { error: error.message });
    throw error;
  }
}

async function createIndex(collection, indexDef) {
  try {
    log(`  Creating: ${indexDef.name}...`, 'cyan');
    await collection.createIndex(indexDef.spec, indexDef.options);
    log(`  ✓ Created: ${indexDef.name}`, 'green');
    return { success: true, name: indexDef.name };
  } catch (error) {
    log(`  ✗ Failed: ${indexDef.name} - ${error.message}`, 'red');
    return { success: false, name: indexDef.name, error: error.message };
  }
}

async function migrateIndexes() {
  const MONGODB_URI = process.env.MONGODB_URI;

  if (!MONGODB_URI) {
    log('ERROR: MONGODB_URI environment variable is not set', 'red');
    process.exit(1);
  }

  log('\n========================================', 'bright');
  log('Conversation Search Index Migration', 'bright');
  log('========================================\n', 'bright');

  try {
    // Connect to MongoDB
    log('Connecting to MongoDB...', 'cyan');
    await mongoose.connect(MONGODB_URI);
    log('✓ Connected to MongoDB\n', 'green');

    // Get conversations collection
    const db = mongoose.connection.db;
    const collection = db.collection('conversations');

    // Get existing indexes
    log('Checking existing indexes...', 'cyan');
    const existingIndexes = await getExistingIndexes(collection);
    log(`Found ${existingIndexes.length} existing indexes:`, 'yellow');
    existingIndexes.forEach(name => log(`  - ${name}`, 'yellow'));
    log('');

    // Filter indexes to create (skip existing)
    const indexesToCreate = INDEXES_TO_CREATE.filter(
      idx => !existingIndexes.includes(idx.name)
    );

    if (indexesToCreate.length === 0) {
      log('✓ All indexes already exist. Nothing to do.', 'green');
      await mongoose.disconnect();
      return;
    }

    log(`Creating ${indexesToCreate.length} new indexes...\n`, 'cyan');

    // Create indexes
    const results = [];
    for (const indexDef of indexesToCreate) {
      const result = await createIndex(collection, indexDef);
      results.push(result);
    }

    // Report results
    log('\n========================================', 'bright');
    log('Migration Results', 'bright');
    log('========================================\n', 'bright');

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    log(`Total: ${results.length}`, 'cyan');
    log(`Success: ${successCount}`, 'green');
    log(`Failed: ${failureCount}`, failureCount > 0 ? 'red' : 'cyan');

    if (failureCount > 0) {
      log('\nFailed indexes:', 'red');
      results
        .filter(r => !r.success)
        .forEach(r => log(`  - ${r.name}: ${r.error}`, 'red'));
    }

    log('\n✓ Migration complete!\n', 'green');

    // Get updated index list
    const finalIndexes = await getExistingIndexes(collection);
    log(`Total indexes now: ${finalIndexes.length}\n`, 'cyan');

  } catch (error) {
    log(`\nERROR: Migration failed`, 'red');
    log(`${error.message}\n`, 'red');
    logger.error('Index migration failed', { error: error.message, stack: error.stack });
    process.exit(1);
  } finally {
    // Disconnect from MongoDB
    await mongoose.disconnect();
    log('Disconnected from MongoDB', 'cyan');
  }
}

// Run migration
if (require.main === module) {
  migrateIndexes()
    .then(() => {
      log('\nDone!', 'bright');
      process.exit(0);
    })
    .catch(error => {
      log(`\nFatal error: ${error.message}`, 'red');
      process.exit(1);
    });
}

module.exports = { migrateIndexes };
