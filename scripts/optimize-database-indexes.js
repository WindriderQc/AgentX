/**
 * Database Index Optimization Script
 *
 * Audits and adds missing indexes for performance
 * Run: node scripts/optimize-database-indexes.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const logger = require('../config/logger');

// Import all models to ensure indexes are registered
const Conversation = require('../models/Conversation');
const AuditLog = require('../models/AuditLog');
const APIKey = require('../models/APIKey');
const BenchmarkResult = require('../models/BenchmarkResult');
const Alert = require('../models/Alert');
const PromptConfig = require('../models/PromptConfig');
const UserProfile = require('../models/UserProfile');
const ModelRegistry = require('../models/ModelRegistry');
const CustomModel = require('../models/CustomModel');
const ActivityLog = require('../models/ActivityLog');

async function analyzeIndexes() {
  console.log('📊 Analyzing database indexes...\n');

  const models = [
    { name: 'Conversation', model: Conversation },
    { name: 'AuditLog', model: AuditLog },
    { name: 'APIKey', model: APIKey },
    { name: 'BenchmarkResult', model: BenchmarkResult },
    { name: 'Alert', model: Alert },
    { name: 'PromptConfig', model: PromptConfig },
    { name: 'UserProfile', model: UserProfile },
    { name: 'ModelRegistry', model: ModelRegistry },
    { name: 'CustomModel', model: CustomModel },
    { name: 'ActivityLog', model: ActivityLog }
  ];

  for (const { name, model } of models) {
    try {
      const collection = mongoose.connection.collection(model.collection.name);
      const indexes = await collection.indexes();

      console.log(`\n🔍 ${name} (${model.collection.name})`);
      console.log(`   Indexes: ${indexes.length}`);

      indexes.forEach((index, i) => {
        const keys = Object.keys(index.key).map(k => `${k}: ${index.key[k]}`).join(', ');
        const unique = index.unique ? ' [UNIQUE]' : '';
        const sparse = index.sparse ? ' [SPARSE]' : '';
        console.log(`   ${i + 1}. { ${keys} }${unique}${sparse}`);
      });

      // Get collection stats
      const stats = await collection.stats();
      console.log(`   Documents: ${stats.count.toLocaleString()}`);
      console.log(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Avg Doc Size: ${(stats.avgObjSize / 1024).toFixed(2)} KB`);
    } catch (error) {
      console.log(`   ⚠️  Error analyzing ${name}: ${error.message}`);
    }
  }
}

async function addMissingIndexes() {
  console.log('\n\n🔧 Adding missing indexes...\n');

  const indexOperations = [];

  // Conversation: Add compound indexes for common queries
  indexOperations.push({
    collection: 'conversations',
    index: { userId: 1, createdAt: -1 },
    options: { name: 'userId_createdAt_desc' },
    description: 'User conversation history (sorted by date)'
  });

  indexOperations.push({
    collection: 'conversations',
    index: { userId: 1, model: 1, createdAt: -1 },
    options: { name: 'userId_model_createdAt' },
    description: 'User conversations by model'
  });

  indexOperations.push({
    collection: 'conversations',
    index: { 'messages.feedback.rating': 1, createdAt: -1 },
    options: { name: 'feedback_rating_createdAt', sparse: true },
    description: 'Feedback analytics queries'
  });

  // AuditLog: Already has good indexes from schema, add compound ones
  indexOperations.push({
    collection: 'auditlogs',
    index: { action: 1, timestamp: -1 },
    options: { name: 'action_timestamp_desc' },
    description: 'Action-specific audit queries'
  });

  indexOperations.push({
    collection: 'auditlogs',
    index: { resourceId: 1, timestamp: -1 },
    options: { name: 'resourceId_timestamp_desc' },
    description: 'Resource audit trail'
  });

  // BenchmarkResult: Aggregation queries
  indexOperations.push({
    collection: 'benchmarkresults',
    index: { modelName: 1, batchId: 1 },
    options: { name: 'modelName_batchId' },
    description: 'Model performance by batch'
  });

  indexOperations.push({
    collection: 'benchmarkresults',
    index: { 'scores.composite': -1, createdAt: -1 },
    options: { name: 'composite_score_desc' },
    description: 'Leaderboard queries'
  });

  // Alert: Time-based queries
  indexOperations.push({
    collection: 'alerts',
    index: { status: 1, severity: 1, createdAt: -1 },
    options: { name: 'status_severity_createdAt' },
    description: 'Alert dashboard queries'
  });

  indexOperations.push({
    collection: 'alerts',
    index: { resolved: 1, createdAt: -1 },
    options: { name: 'resolved_createdAt_desc' },
    description: 'Unresolved alerts'
  });

  // PromptConfig: Active prompt lookup
  indexOperations.push({
    collection: 'promptconfigs',
    index: { name: 1, status: 1, trafficWeight: -1 },
    options: { name: 'name_status_weight' },
    description: 'Active prompt selection'
  });

  // CustomModel: Deployment status queries
  indexOperations.push({
    collection: 'custommodels',
    index: { userId: 1, deploymentStatus: 1 },
    options: { name: 'userId_deploymentStatus' },
    description: 'User model deployments'
  });

  // ActivityLog: Recent activity queries
  indexOperations.push({
    collection: 'activitylogs',
    index: { userId: 1, timestamp: -1 },
    options: { name: 'userId_timestamp_desc' },
    description: 'User activity timeline'
  });

  indexOperations.push({
    collection: 'activitylogs',
    index: { action: 1, timestamp: -1 },
    options: { name: 'action_timestamp_desc' },
    description: 'Action-specific activity'
  });

  // Execute index creation
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const op of indexOperations) {
    try {
      const collection = mongoose.connection.collection(op.collection);

      // Check if index already exists
      const existing = await collection.indexes();
      const indexName = op.options.name;
      const exists = existing.some(idx => idx.name === indexName);

      if (exists) {
        console.log(`   ⏭️  ${op.collection}.${indexName} - Already exists`);
        skipped++;
      } else {
        await collection.createIndex(op.index, op.options);
        console.log(`   ✅ ${op.collection}.${indexName} - Created`);
        console.log(`      ${op.description}`);
        created++;
      }
    } catch (error) {
      console.log(`   ❌ ${op.collection}.${op.options.name} - Error: ${error.message}`);
      errors++;
    }
  }

  console.log(`\n📈 Index Creation Summary:`);
  console.log(`   Created: ${created}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);
}

async function main() {
  try {
    console.log('🚀 Database Index Optimization\n');

    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';
    console.log(`Connecting to: ${mongoUri}`);

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    // Analyze existing indexes
    await analyzeIndexes();

    // Add missing indexes
    await addMissingIndexes();

    console.log('\n✅ Index optimization complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
