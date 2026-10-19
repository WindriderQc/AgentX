'use strict';

/**
 * Vector stores and RagStores for a named collection and embedding model.
 * With VECTOR_STORE_TYPE=memory each collection keeps one store for the life
 * of the process, so a build and the serving store see the same data.
 */

const { createVectorStore } = require('./vectorStore/factory');
const { EmbeddingsService } = require('./embeddings');

const memoryStores = new Map();

function storeForCollection(collection, dimension, type = process.env.VECTOR_STORE_TYPE) {
  if (type === 'memory') {
    if (!memoryStores.has(collection)) {
      memoryStores.set(collection, createVectorStore({ type, collectionName: collection, vectorDimension: dimension }));
    }
    return memoryStores.get(collection);
  }
  return createVectorStore({ type, collectionName: collection, vectorDimension: dimension });
}

function embeddingsFor(model, dimension) {
  return new EmbeddingsService({ embeddingModel: model, dimension });
}

function ragStoreFor({ collection, model, dimension }) {
  const { RagStore } = require('./ragStore');
  return new RagStore({
    vectorStore: storeForCollection(collection, dimension),
    embeddingsService: embeddingsFor(model, dimension)
  });
}

function resetMemoryStores() {
  memoryStores.clear();
}

module.exports = { storeForCollection, embeddingsFor, ragStoreFor, resetMemoryStores };
