#!/usr/bin/env node
'use strict';

/**
 * Command-line entry for the collection copy in src/services/embeddingCollectionMigration.js:
 * copy every RAG document from one Qdrant collection into another, re-embedded
 * with the configured EMBEDDING_MODEL / EMBEDDING_DIMENSION. The source
 * collection is only read. Run inside the rag container:
 *
 *   node scripts/migrate-embedding-collection.js --source <old> --target <new>
 *     [--dry-run] [--delta] [--limit N] [--page-size N]
 *
 * Each document is rebuilt from its chunk-0 payload (originalText and the
 * document metadata) through RagStore.upsertDocumentWithChunks, so chunking,
 * Markdown parsing and identity rules are the ingestion ones. A document
 * without originalText is reported and skipped, never reconstructed.
 */

const {
  migrateEmbeddingCollection,
  buildUpsertMetadata,
  UsageError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE
} = require('../src/services/embeddingCollectionMigration');

function positiveInteger(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new UsageError(`${name} must be a positive integer`);
  return number;
}

function parseArgs(argv) {
  const options = { dryRun: false, delta: false, limit: null, pageSize: DEFAULT_PAGE_SIZE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--source') options.source = value();
    else if (arg === '--target') options.target = value();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--delta') options.delta = true;
    else if (arg === '--limit') options.limit = positiveInteger('--limit', value());
    else if (arg === '--page-size') options.pageSize = Math.min(positiveInteger('--page-size', value()), MAX_PAGE_SIZE);
    else throw new UsageError(`unknown argument ${arg}`);
  }
  if (!options.source || !options.target) throw new UsageError('--source and --target are required');
  return options;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\nUsage: node scripts/migrate-embedding-collection.js --source <collection> --target <collection> [--dry-run] [--delta] [--limit N] [--page-size N]\n`);
    return 2;
  }
  const QdrantVectorStore = require('../src/services/vectorStore/QdrantVectorStore');
  const { RagStore } = require('../src/services/ragStore');
  const embeddingDimension = Number(env.EMBEDDING_DIMENSION);
  const deps = {
    sourceStore: new QdrantVectorStore({ collectionName: options.source }),
    targetStore: new QdrantVectorStore({ collectionName: options.target, vectorDimension: embeddingDimension }),
    targetRagStore: options.dryRun ? null : new RagStore({ type: 'qdrant', collectionName: options.target, vectorDimension: embeddingDimension }),
    embeddingModel: env.EMBEDDING_MODEL || null,
    embeddingDimension
  };
  try {
    const summary = await migrateEmbeddingCollection(options, deps);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.failed.length ? 1 : 0;
  } catch (err) {
    process.stderr.write(`migration stopped: ${err.message}\n`);
    if (err.summary) process.stdout.write(`${JSON.stringify(err.summary, null, 2)}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (require.main === module) {
  // Exit explicitly once stdout is flushed: service singletons may hold timers.
  main().then((code) => process.stdout.write('', () => process.exit(code)));
}

module.exports = { migrateEmbeddingCollection, buildUpsertMetadata, parseArgs, main, UsageError };
