/**
 * RAG Context Builder
 * Retrieval-augmented generation context construction and document listing
 */

const logger = require('../../../config/logger');
const { resolveTarget } = require('../../utils');
const { getCompressionService } = require('../ragCompression');
const { getRAGCache } = require('../ragCache');

/**
 * Build RAG context from a message using the provided ragStore
 * @param {string} message - User message to search for
 * @param {Object} ragStore - RAG store instance
 * @param {Object} options - Configuration options
 * @param {string} options.effectiveTarget - Ollama target for embedding
 * @param {number} options.ragTopK - Number of results to retrieve
 * @param {Object} options.ragFilters - Filters for search
 * @param {Object} options.ragOptions - Advanced RAG options (ragExpand, ragRerank, ragHybrid, ragCompress)
 * @returns {Promise<Object>} { ragUsed, ragSources, ragContext }
 */
async function buildRagContext(message, ragStore, options = {}) {
    const { effectiveTarget, ragTopK, ragFilters, ragOptions = {} } = options;
    let ragUsed = false;
    let ragSources = [];
    let ragContext = null;

    try {
        const ollamaHost = resolveTarget(effectiveTarget);
        const ragCache = getRAGCache();

        // Check if we have a cached result for this query
        const cachedResult = await ragCache.get(message);
        let searchResults = [];

        if (cachedResult) {
            logger.info('RAG cache hit - using cached results');
            searchResults = cachedResult;
        } else {
            // Perform new search
            searchResults = await ragStore.searchSimilarChunks(message, {
                topK: ragTopK || 5,
                minScore: 0.25,
                filters: ragFilters,
                ollamaHost,
                expandQuery: ragOptions.ragExpand === true,
                rerankResults: ragOptions.ragRerank === true,
                hybridSearch: ragOptions.ragHybrid === true
            });

            // Cache the new results
            await ragCache.set(message, searchResults);
        }

        // Contextual compression
        let processedChunks = searchResults;
        if (ragOptions.ragCompress === true && searchResults.length > 0) {
            try {
                const compressionService = getCompressionService();
                processedChunks = await compressionService.compressChunks(
                    message,
                    searchResults,
                    {
                        compressionModel: process.env.COMPRESSION_MODEL || 'gemma2:2b',
                        minRelevanceScore: parseFloat(process.env.COMPRESSION_MIN_RELEVANCE) || 0.6,
                        maxSentencesPerChunk: parseInt(process.env.COMPRESSION_MAX_SENTENCES, 10) || 5
                    }
                );
            } catch (compErr) {
                logger.error('RAG Compression failed, using original chunks', { error: compErr.message });
                processedChunks = searchResults;
            }
        }

        if (processedChunks.length > 0) {
            ragUsed = true;
            ragContext = '\n\n=== RETRIEVED CONTEXT ===\n';
            ragContext += 'When using information from these sources, cite them inline with [1], [2], etc.\n\n';
            processedChunks.forEach((result, idx) => {
                const textToUse = result.compressedText !== undefined ? result.compressedText : result.text;
                ragContext += `\n[Source ${idx + 1}: ${result.metadata.title}]\n${textToUse}\n`;
                ragSources.push({
                    text: result.text.substring(0, 200),
                    score: result.score,
                    source: result.metadata.source,
                    title: result.metadata.title,
                    documentId: result.metadata.documentId,
                    wasCompressed: result.wasCompressed || false,
                    compressionRatio: result.compressionRatio || 0
                });
            });
            ragContext += '\n=== END CONTEXT ===\n';
        }

        // Check for "List Files" intent
        const listFilesRegex = /list.*files|what.*files.*ingested|show.*documents|which.*files|what.*do.*you.*have/i;
        if (listFilesRegex.test(message)) {
            logger.info('Detected file listing intent');
            const docs = await ragStore.listDocuments();
            if (docs.length > 0) {
                ragUsed = true;
                const docList = docs.map(d => `- ${d.title} (Source: ${d.source})`).join('\n');
                const docContext = `\n\n=== Available Ingested Documents ===\nThe following files are currently ingested in the RAG system:\n${docList}\n=== End Document List ===\n`;

                if (ragContext) {
                    ragContext = docContext + ragContext;
                } else {
                    ragContext = docContext;
                }
                logger.info('Injected document list', { count: docs.length });
            }
        }

    } catch (err) {
        logger.error('RAG retrieval error', { error: err.message });
    }

    return { ragUsed, ragSources, ragContext };
}

module.exports = { buildRagContext };
