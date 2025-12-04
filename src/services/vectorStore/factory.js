/**
 * Vector Store Factory
 * 
 * Creates the appropriate vector store implementation based on configuration.
 * Supports: in-memory, qdrant (more can be added: chroma, pinecone, etc.)
 */

const InMemoryVectorStore = require('./InMemoryVectorStore');
const QdrantVectorStore = require('./QdrantVectorStore');
const logger = require('../../../config/logger');

/**
 * Create a vector store instance
 * @param {string} type - Store type: 'memory' or 'qdrant'
 * @param {Object} config - Configuration options
 * @returns {VectorStoreAdapter}
 */
function createVectorStore(type = null, config = {}) {
  // Determine type from config or environment
  const storeType = type || config.type || process.env.VECTOR_STORE_TYPE || 'memory';

  logger.info('Creating vector store', { type: storeType });

  switch (storeType.toLowerCase()) {
    case 'memory':
    case 'in-memory':
      return new InMemoryVectorStore(config);
    
    case 'qdrant':
      return new QdrantVectorStore(config);
    
    default:
      logger.warn(`Unknown vector store type: ${storeType}, falling back to in-memory`);
      return new InMemoryVectorStore(config);
  }
}

module.exports = { createVectorStore };
