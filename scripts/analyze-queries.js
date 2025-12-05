#!/usr/bin/env node
/**
 * Query Performance Analyzer
 * 
 * Analyzes MongoDB query patterns and provides optimization recommendations
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');
const logger = require('../config/logger');

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

async function analyzeQueries() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║        MongoDB Query Performance Analyzer             ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db();
    
    // Analyze each collection
    await analyzeCollection(db, 'conversations');
    await analyzeCollection(db, 'promptconfigs');
    await analyzeCollection(db, 'userprofiles');
    await analyzeCollection(db, 'sessions');
    
    // Get slow queries (if profiling enabled)
    await analyzeSlowQueries(db);
    
    // Check index usage
    await analyzeIndexUsage(db);
    
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║             Analysis Complete                          ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

async function analyzeCollection(db, collectionName) {
  console.log(`\n📊 Collection: ${collectionName}`);
  console.log('─'.repeat(60));
  
  try {
    const collection = db.collection(collectionName);
    
    // Get stats
    const stats = await collection.stats();
    console.log(`   Documents: ${stats.count.toLocaleString()}`);
    console.log(`   Size: ${formatBytes(stats.size)}`);
    console.log(`   Avg Doc Size: ${formatBytes(stats.avgObjSize || 0)}`);
    console.log(`   Storage: ${formatBytes(stats.storageSize)}`);
    
    // Get indexes
    const indexes = await collection.indexes();
    console.log(`\n   Indexes (${indexes.length}):`);
    indexes.forEach(idx => {
      const keys = Object.keys(idx.key).map(k => `${k}: ${idx.key[k]}`).join(', ');
      console.log(`   - ${idx.name}: { ${keys} }`);
      if (idx.unique) console.log(`     (unique)`);
      if (idx.sparse) console.log(`     (sparse)`);
    });
    
    // Check for common query patterns
    await suggestOptimizations(collection, collectionName);
    
  } catch (err) {
    console.log(`   ⚠️  Could not analyze: ${err.message}`);
  }
}

async function suggestOptimizations(collection, collectionName) {
  const suggestions = [];
  
  // Get sample documents to understand structure
  const sample = await collection.findOne();
  if (!sample) {
    console.log('   ℹ️  Collection is empty');
    return;
  }
  
  console.log('\n   Common Fields:');
  const fields = Object.keys(sample);
  fields.slice(0, 10).forEach(field => {
    const value = sample[field];
    const type = Array.isArray(value) ? 'array' : typeof value;
    console.log(`   - ${field}: ${type}`);
  });
  
  // Check for missing common indexes
  const indexes = await collection.indexes();
  const indexedFields = new Set();
  indexes.forEach(idx => {
    Object.keys(idx.key).forEach(k => indexedFields.add(k));
  });
  
  // Collection-specific recommendations
  if (collectionName === 'conversations') {
    if (!indexedFields.has('userId')) {
      suggestions.push('Add index on userId for user conversation queries');
    }
    if (!indexedFields.has('createdAt')) {
      suggestions.push('Add index on createdAt for chronological sorting');
    }
    if (!indexedFields.has('updatedAt')) {
      suggestions.push('Add index on updatedAt for recent conversation queries');
    }
  }
  
  if (collectionName === 'promptconfigs') {
    if (!indexedFields.has('isActive')) {
      suggestions.push('Add index on isActive for active prompt queries');
    }
    if (!indexedFields.has('version')) {
      suggestions.push('Add index on version for versioning queries');
    }
  }
  
  if (suggestions.length > 0) {
    console.log('\n   💡 Optimization Suggestions:');
    suggestions.forEach(s => console.log(`   - ${s}`));
  } else {
    console.log('\n   ✅ Collection appears well-indexed');
  }
}

async function analyzeSlowQueries(db) {
  console.log('\n\n📈 Slow Query Analysis');
  console.log('─'.repeat(60));
  
  try {
    // Check if profiling is enabled
    const profile = await db.command({ profile: -1 });
    
    if (profile.was === 0) {
      console.log('   ℹ️  Query profiling is disabled');
      console.log('   Enable with: db.setProfilingLevel(1, { slowms: 100 })');
      return;
    }
    
    // Get slow queries from system.profile
    const slowQueries = await db.collection('system.profile')
      .find({ millis: { $gt: 100 } })
      .sort({ millis: -1 })
      .limit(10)
      .toArray();
    
    if (slowQueries.length === 0) {
      console.log('   ✅ No slow queries found (>100ms)');
      return;
    }
    
    console.log(`\n   Found ${slowQueries.length} slow queries:\n`);
    slowQueries.forEach((q, i) => {
      console.log(`   ${i + 1}. ${q.ns} (${q.millis}ms)`);
      console.log(`      Op: ${q.op}`);
      if (q.command) {
        console.log(`      Command: ${JSON.stringify(q.command).substring(0, 100)}...`);
      }
    });
    
  } catch (err) {
    console.log(`   ⚠️  Could not analyze slow queries: ${err.message}`);
  }
}

async function analyzeIndexUsage(db) {
  console.log('\n\n🔍 Index Usage Statistics');
  console.log('─'.repeat(60));
  
  try {
    const collections = ['conversations', 'promptconfigs', 'userprofiles', 'sessions'];
    
    for (const collName of collections) {
      try {
        const stats = await db.collection(collName).aggregate([
          { $indexStats: {} }
        ]).toArray();
        
        if (stats.length === 0) continue;
        
        console.log(`\n   ${collName}:`);
        stats.forEach(stat => {
          const accesses = stat.accesses.ops || 0;
          const lastUsed = stat.accesses.since ? new Date(stat.accesses.since).toISOString() : 'Never';
          console.log(`   - ${stat.name}: ${accesses} ops (since ${lastUsed})`);
        });
        
        // Find unused indexes
        const unused = stats.filter(s => s.accesses.ops === 0 && s.name !== '_id_');
        if (unused.length > 0) {
          console.log(`   ⚠️  Unused indexes: ${unused.map(u => u.name).join(', ')}`);
        }
        
      } catch (err) {
        // $indexStats might not be available in all MongoDB versions
        continue;
      }
    }
    
  } catch (err) {
    console.log(`   ℹ️  Index usage stats not available: ${err.message}`);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Run analysis
analyzeQueries().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
