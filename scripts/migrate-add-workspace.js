/**
 * Migration Script: Add Workspace Support
 *
 * Backfills existing data with default workspace
 *
 * Week 4 Day 1 - Multi-Tenancy Migration
 *
 * Usage: node scripts/migrate-add-workspace.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const logger = require('../config/logger');

// Import models
const Workspace = require('../models/Workspace');
const WorkspaceMember = require('../models/WorkspaceMember');
const Conversation = require('../models/Conversation');
const PromptConfig = require('../models/PromptConfig');
const APIKey = require('../models/APIKey');
const BenchmarkResult = require('../models/BenchmarkResult');
const CustomModel = require('../models/CustomModel');
const Alert = require('../models/Alert');
const AuditLog = require('../models/AuditLog');
const UserProfile = require('../models/UserProfile');

async function createDefaultWorkspace() {
  console.log('\n🏢 Step 1: Creating default workspace...\n');

  // Check if default workspace exists
  let defaultWorkspace = await Workspace.findOne({ slug: 'default' });

  if (defaultWorkspace) {
    console.log(`   ✅ Default workspace already exists (ID: ${defaultWorkspace._id})`);
    return defaultWorkspace;
  }

  // Find system admin or first user
  const systemUser = await UserProfile.findOne({ isAdmin: true });
  const firstUser = systemUser || await UserProfile.findOne({});

  if (!firstUser) {
    console.log('   ⚠️  No users found. Creating workspace without owner.');
    // Create workspace with placeholder owner (will need manual fix)
    defaultWorkspace = await Workspace.create({
      name: 'Default Workspace',
      slug: 'default',
      description: 'Automatically created default workspace for existing data',
      ownerId: new mongoose.Types.ObjectId(), // Placeholder
      settings: {
        apiKeyEnabled: true,
        ragEnabled: true,
        customModelsEnabled: true,
        benchmarkingEnabled: true,
        alertsEnabled: true
      }
    });

    console.log(`   ✅ Created default workspace (no owner - manual fix needed)`);
    return defaultWorkspace;
  }

  // Create default workspace owned by system admin/first user
  defaultWorkspace = await Workspace.create({
    name: 'Default Workspace',
    slug: 'default',
    description: 'Automatically created default workspace for existing data',
    ownerId: firstUser._id,
    settings: {
      apiKeyEnabled: true,
      ragEnabled: true,
      customModelsEnabled: true,
      benchmarkingEnabled: true,
      alertsEnabled: true
    }
  });

  console.log(`   ✅ Created default workspace (Owner: ${firstUser.name || firstUser.userId})`);

  // Create workspace membership for owner
  await WorkspaceMember.create({
    workspaceId: defaultWorkspace._id,
    userId: firstUser._id,
    role: 'owner',
    permissions: {
      chat: true,
      rag: true,
      models: true,
      benchmark: true,
      alerts: true,
      settings: true
    }
  });

  console.log(`   ✅ Created workspace membership for owner`);

  return defaultWorkspace;
}

async function addAllUsersToDefaultWorkspace(defaultWorkspace) {
  console.log('\n👥 Step 2: Adding all users to default workspace...\n');

  // Get all users except the owner
  const users = await UserProfile.find({
    _id: { $ne: defaultWorkspace.ownerId }
  });

  if (users.length === 0) {
    console.log('   ℹ️  No additional users to add');
    return;
  }

  let added = 0;
  let skipped = 0;

  for (const user of users) {
    try {
      // Check if already a member
      const existing = await WorkspaceMember.findOne({
        workspaceId: defaultWorkspace._id,
        userId: user._id
      });

      if (existing) {
        skipped++;
        continue;
      }

      // Add as member
      await WorkspaceMember.create({
        workspaceId: defaultWorkspace._id,
        userId: user._id,
        role: user.isAdmin ? 'admin' : 'member',
        permissions: {
          chat: true,
          rag: true,
          models: user.isAdmin,
          benchmark: user.isAdmin,
          alerts: user.isAdmin,
          settings: false
        }
      });

      added++;
    } catch (error) {
      console.log(`   ❌ Failed to add user ${user.userId}: ${error.message}`);
    }
  }

  console.log(`   ✅ Added ${added} users to default workspace`);
  if (skipped > 0) {
    console.log(`   ⏭️  Skipped ${skipped} users (already members)`);
  }
}

async function backfillCollection(Model, collectionName, workspaceId) {
  console.log(`\n   Processing ${collectionName}...`);

  // Count records without workspaceId
  const count = await Model.countDocuments({
    workspaceId: { $exists: false }
  });

  if (count === 0) {
    console.log(`      ✅ ${collectionName}: Already migrated (0 records to update)`);
    return { collection: collectionName, updated: 0, errors: 0 };
  }

  console.log(`      🔄 ${collectionName}: Found ${count} records to migrate`);

  try {
    // Batch update all records
    const result = await Model.updateMany(
      { workspaceId: { $exists: false } },
      { $set: { workspaceId } }
    );

    console.log(`      ✅ ${collectionName}: Updated ${result.modifiedCount} records`);

    return {
      collection: collectionName,
      updated: result.modifiedCount,
      errors: 0
    };
  } catch (error) {
    console.log(`      ❌ ${collectionName}: Error - ${error.message}`);

    return {
      collection: collectionName,
      updated: 0,
      errors: 1
    };
  }
}

async function backfillAllCollections(defaultWorkspace) {
  console.log('\n📦 Step 3: Backfilling workspaceId to existing records...\n');

  const results = [];

  // Collections to migrate
  const collections = [
    { model: Conversation, name: 'conversations' },
    { model: PromptConfig, name: 'promptconfigs' },
    { model: APIKey, name: 'apikeys' },
    { model: BenchmarkResult, name: 'benchmarkresults' },
    { model: CustomModel, name: 'custommodels' },
    { model: Alert, name: 'alerts' },
    { model: AuditLog, name: 'auditlogs' }
  ];

  for (const { model, name } of collections) {
    const result = await backfillCollection(model, name, defaultWorkspace._id);
    results.push(result);
  }

  return results;
}

async function printSummary(results, startTime) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n\n📊 Migration Summary\n');
  console.log('═'.repeat(60));

  let totalUpdated = 0;
  let totalErrors = 0;

  for (const result of results) {
    const status = result.errors > 0 ? '❌' : '✅';
    console.log(`${status} ${result.collection.padEnd(25)} ${result.updated} records updated`);
    totalUpdated += result.updated;
    totalErrors += result.errors;
  }

  console.log('═'.repeat(60));
  console.log(`\nTotal Records Updated: ${totalUpdated}`);
  console.log(`Total Errors: ${totalErrors}`);
  console.log(`Duration: ${duration}s`);

  if (totalErrors === 0) {
    console.log('\n✅ Migration completed successfully!\n');
  } else {
    console.log('\n⚠️  Migration completed with errors. Review logs above.\n');
  }
}

async function verifyMigration(defaultWorkspace) {
  console.log('\n🔍 Step 4: Verifying migration...\n');

  const collections = [
    { model: Conversation, name: 'conversations' },
    { model: PromptConfig, name: 'promptconfigs' },
    { model: APIKey, name: 'apikeys' },
    { model: BenchmarkResult, name: 'benchmarkresults' },
    { model: CustomModel, name: 'custommodels' },
    { model: Alert, name: 'alerts' },
    { model: AuditLog, name: 'auditlogs' }
  ];

  let allGood = true;

  for (const { model, name } of collections) {
    const withoutWorkspace = await model.countDocuments({
      workspaceId: { $exists: false }
    });

    const withWorkspace = await model.countDocuments({
      workspaceId: defaultWorkspace._id
    });

    if (withoutWorkspace > 0) {
      console.log(`   ⚠️  ${name}: ${withoutWorkspace} records still missing workspaceId`);
      allGood = false;
    } else {
      console.log(`   ✅ ${name}: All ${withWorkspace} records have workspaceId`);
    }
  }

  if (allGood) {
    console.log('\n✅ Verification passed! All records have workspaceId.\n');
  } else {
    console.log('\n⚠️  Verification found issues. Some records still missing workspaceId.\n');
  }

  return allGood;
}

async function main() {
  const startTime = Date.now();

  try {
    console.log('\n🚀 Workspace Migration Script\n');
    console.log('This script will:');
    console.log('  1. Create default workspace (if needed)');
    console.log('  2. Add all users to default workspace');
    console.log('  3. Backfill workspaceId to all existing records');
    console.log('  4. Verify migration\n');

    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';
    console.log(`Connecting to: ${mongoUri}\n`);

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    // Step 1: Create default workspace
    const defaultWorkspace = await createDefaultWorkspace();

    // Step 2: Add all users to default workspace
    await addAllUsersToDefaultWorkspace(defaultWorkspace);

    // Step 3: Backfill collections
    const results = await backfillAllCollections(defaultWorkspace);

    // Print summary
    await printSummary(results, startTime);

    // Step 4: Verify migration
    await verifyMigration(defaultWorkspace);

    console.log('✅ Migration complete! You can now use multi-tenancy features.\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
