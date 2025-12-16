#!/usr/bin/env node
/**
 * Vector Store Migration Script
 * 
 * Migrates RAG documents between vector store implementations.
 * Use cases:
 * - Migrate from in-memory to Qdrant for production
 * - Backup and restore vector data
 * - Switch between vector store providers
 * 
 * Usage:
 *   node scripts/migrate-vector-store.js --from memory --to qdrant
 *   node scripts/migrate-vector-store.js --export backup.json
 *   node scripts/migrate-vector-store.js --import backup.json --to qdrant
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { createVectorStore } = require('../src/services/vectorStore/factory');
const logger = require('../config/logger');

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (flag) => {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : null;
};

const fromType = getArg('--from');
const toType = getArg('--to');
const exportFile = getArg('--export');
const importFile = getArg('--import');

async function exportDocuments(store, filename) {
  logger.info('Exporting documents', { store: store.constructor.name });
  
  const documents = await store.listDocuments();
  const exportData = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    documentCount: documents.length,
    documents: []
  };

  for (const doc of documents) {
    logger.info('Exporting document', { documentId: doc.documentId, title: doc.title });
    
    // Get all chunks for this document
    const chunks = [];
    const stats = await store.getStats();
    
    // For in-memory store, we can access vectors directly
    if (store.vectors) {
      const docChunks = store.vectors.filter(v => v.documentId === doc.documentId);
      chunks.push(...docChunks.map(c => ({
        chunkIndex: c.chunkIndex,
        text: c.text,
        embedding: c.embedding
      })));
    } else {
      logger.warn('Cannot extract embeddings from this store type, export will be incomplete');
    }

    exportData.documents.push({
      metadata: doc,
      chunks
    });
  }

  await fs.writeFile(filename, JSON.stringify(exportData, null, 2));
  logger.info('Export completed', { filename, documentCount: exportData.documents.length });
  
  return exportData;
}

async function importDocuments(store, filename) {
  logger.info('Importing documents', { store: store.constructor.name, filename });
  
  const data = JSON.parse(await fs.readFile(filename, 'utf8'));
  
  logger.info('Import data loaded', { 
    version: data.version, 
    documentCount: data.documentCount 
  });

  let imported = 0;
  for (const item of data.documents) {
    try {
      await store.upsertDocument(
        item.metadata.documentId,
        item.metadata,
        item.chunks
      );
      imported++;
      logger.info('Imported document', { 
        documentId: item.metadata.documentId, 
        title: item.metadata.title 
      });
    } catch (err) {
      logger.error('Failed to import document', { 
        documentId: item.metadata.documentId, 
        error: err.message 
      });
    }
  }

  logger.info('Import completed', { imported, total: data.documents.length });
  return imported;
}

async function migrateDocuments(fromStore, toStore) {
  logger.info('Starting migration', { 
    from: fromStore.constructor.name, 
    to: toStore.constructor.name 
  });

  const documents = await fromStore.listDocuments();
  logger.info('Documents to migrate', { count: documents.length });

  let migrated = 0;
  for (const doc of documents) {
    try {
      logger.info('Migrating document', { documentId: doc.documentId, title: doc.title });
      
      // Get chunks from source store
      const chunks = [];
      if (fromStore.vectors) {
        const docChunks = fromStore.vectors.filter(v => v.documentId === doc.documentId);
        chunks.push(...docChunks.map(c => ({
          chunkIndex: c.chunkIndex,
          text: c.text,
          embedding: c.embedding
        })));
      } else {
        logger.error('Cannot extract chunks from source store', { documentId: doc.documentId });
        continue;
      }

      // Upsert to destination store
      await toStore.upsertDocument(doc.documentId, doc, chunks);
      migrated++;
      
      logger.info('Document migrated successfully', { documentId: doc.documentId });
    } catch (err) {
      logger.error('Failed to migrate document', { 
        documentId: doc.documentId, 
        error: err.message 
      });
    }
  }

  logger.info('Migration completed', { migrated, total: documents.length });
  return migrated;
}

async function main() {
  try {
    // Export mode
    if (exportFile) {
      const storeType = fromType || 'memory';
      const store = createVectorStore(storeType);
      
      const isHealthy = await store.healthCheck();
      if (!isHealthy) {
        throw new Error(`Source store (${storeType}) is not healthy`);
      }

      await exportDocuments(store, exportFile);
      logger.info('Export operation completed successfully');
      process.exit(0);
    }

    // Import mode
    if (importFile) {
      if (!toType) {
        throw new Error('--to flag is required for import');
      }

      const store = createVectorStore(toType);
      
      const isHealthy = await store.healthCheck();
      if (!isHealthy) {
        throw new Error(`Target store (${toType}) is not healthy`);
      }

      await importDocuments(store, importFile);
      logger.info('Import operation completed successfully');
      process.exit(0);
    }

    // Migration mode
    if (fromType && toType) {
      if (fromType === toType) {
        throw new Error('Source and destination stores cannot be the same');
      }

      const sourceStore = createVectorStore(fromType);
      const targetStore = createVectorStore(toType);

      // Health checks
      const sourceHealthy = await sourceStore.healthCheck();
      const targetHealthy = await targetStore.healthCheck();

      if (!sourceHealthy) {
        throw new Error(`Source store (${fromType}) is not healthy`);
      }
      if (!targetHealthy) {
        throw new Error(`Target store (${toType}) is not healthy`);
      }

      await migrateDocuments(sourceStore, targetStore);
      logger.info('Migration operation completed successfully');
      process.exit(0);
    }

    // No valid mode specified
    console.log(`
Vector Store Migration Tool

Usage:
  # Migrate between stores
  node scripts/migrate-vector-store.js --from memory --to qdrant
  
  # Export to JSON file
  node scripts/migrate-vector-store.js --from memory --export backup.json
  
  # Import from JSON file
  node scripts/migrate-vector-store.js --import backup.json --to qdrant

Options:
  --from <type>      Source vector store type (memory, qdrant)
  --to <type>        Target vector store type (memory, qdrant)
  --export <file>    Export documents to JSON file
  --import <file>    Import documents from JSON file

Environment Variables:
  VECTOR_STORE_TYPE  Default vector store type
  QDRANT_HOST        Qdrant server URL (default: http://localhost:6333)
  QDRANT_COLLECTION  Qdrant collection name (default: agentx_documents)

Examples:
  # Export in-memory data before switching to Qdrant
  node scripts/migrate-vector-store.js --from memory --export backup.json
  
  # Import into Qdrant after setup
  node scripts/migrate-vector-store.js --import backup.json --to qdrant
  
  # Direct migration (if both stores available)
  node scripts/migrate-vector-store.js --from memory --to qdrant
`);
    process.exit(1);

  } catch (err) {
    logger.error('Migration failed', { error: err.message, stack: err.stack });
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
