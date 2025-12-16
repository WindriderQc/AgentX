#!/usr/bin/env node
/**
 * Qdrant Migration Script
 * 
 * Migrates existing RAG documents from in-memory/old store to Qdrant.
 * Can also be used to verify Qdrant setup.
 */

require('dotenv').config();
const { RagStore } = require('../src/services/ragStore');
const logger = require('../config/logger');

async function testQdrantConnection() {
  console.log('\n🔍 Testing Qdrant Connection...\n');
  
  try {
    // Test basic connectivity
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    const response = await fetch(`${qdrantUrl}/healthz`);
    
    if (!response.ok) {
      throw new Error(`Qdrant health check failed: ${response.status}`);
    }
    
    console.log('✅ Qdrant is healthy and accessible');
    
    // Test collection listing
    const collectionsRes = await fetch(`${qdrantUrl}/collections`);
    const collections = await collectionsRes.json();
    console.log(`✅ Connected to Qdrant at ${qdrantUrl}`);
    console.log(`📊 Existing collections: ${collections.result?.collections?.length || 0}`);
    
    return true;
  } catch (err) {
    console.error('❌ Qdrant connection failed:', err.message);
    return false;
  }
}

async function testRagStoreWithQdrant() {
  console.log('\n🧪 Testing RAG Store with Qdrant...\n');
  
  try {
    // Create RAG store with Qdrant
    const ragStore = new RagStore({
      vectorStoreType: 'qdrant',
      url: process.env.QDRANT_URL,
      collection: process.env.QDRANT_COLLECTION
    });
    
    console.log('✅ RAG Store initialized with Qdrant backend');
    
    // Test document upsert
    const testDoc = {
      source: 'test',
      path: 'test/qdrant-verification.txt',
      title: 'Qdrant Integration Test',
      tags: ['test', 'qdrant'],
      author: 'AgentX',
      createdAt: new Date().toISOString()
    };
    
    const testText = `
      This is a test document to verify Qdrant integration.
      It contains multiple sentences to test chunking and embedding.
      The RAG store should split this into chunks and store them in Qdrant.
      Each chunk will have its own vector embedding for semantic search.
    `;
    
    console.log('📝 Upserting test document...');
    const result = await ragStore.upsertDocumentWithChunks(testDoc, testText);
    console.log('✅ Document upserted successfully:', result);
    
    // Test search
    console.log('\n🔍 Testing semantic search...');
    const searchResults = await ragStore.searchSimilarChunks('test chunking', { topK: 3 });
    console.log(`✅ Found ${searchResults.length} relevant chunks`);
    
    if (searchResults.length > 0) {
      console.log('\n📄 Top result:');
      console.log(`   Score: ${searchResults[0].score.toFixed(4)}`);
      console.log(`   Text: ${searchResults[0].text.substring(0, 100)}...`);
    }
    
    // Test document deletion
    console.log('\n🗑️  Testing document deletion...');
    await ragStore.deleteDocument(result.documentId);
    console.log('✅ Test document deleted successfully');
    
    return true;
  } catch (err) {
    console.error('❌ RAG Store test failed:', err.message);
    console.error(err.stack);
    return false;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║          Qdrant Integration Verification              ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  
  // Check environment
  console.log('\n📋 Configuration:');
  console.log(`   VECTOR_STORE_TYPE: ${process.env.VECTOR_STORE_TYPE || 'memory'}`);
  console.log(`   QDRANT_URL: ${process.env.QDRANT_URL || 'http://localhost:6333'}`);
  console.log(`   QDRANT_COLLECTION: ${process.env.QDRANT_COLLECTION || 'agentx_embeddings'}`);
  
  // Run tests
  const connectionOk = await testQdrantConnection();
  if (!connectionOk) {
    console.log('\n❌ Qdrant connection test failed. Please ensure Qdrant is running.');
    console.log('   Start Qdrant: ./qdrant --config-path qdrant_config.yaml');
    process.exit(1);
  }
  
  const ragStoreOk = await testRagStoreWithQdrant();
  if (!ragStoreOk) {
    console.log('\n❌ RAG Store test failed. Check logs for details.');
    process.exit(1);
  }
  
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║          ✅ All Tests Passed!                          ║');
  console.log('║          Qdrant is ready for production use            ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
