const fetchWithTimeout = require('../../utils/fetchWithTimeout');
const {
  SERVICE_OUTBOUND_OPERATION_IDS,
  SERVICE_OUTBOUND_TIMEOUTS,
  configuredServiceOrigin,
} = require('../../clients/serviceOutboundClient');
const logger = require('../../../config/logger');

const EMBEDDING_TIMEOUT = SERVICE_OUTBOUND_TIMEOUTS[
  SERVICE_OUTBOUND_OPERATION_IDS.CORE_EMBED
];

class CoreProxyProvider {
  constructor(config = {}) {
    this.name = 'core-proxy';
    this.coreProxyUrl = configuredServiceOrigin(
      config.coreProxyUrl || process.env.CORE_PROXY_URL || 'http://localhost:3080'
    );
    this.model = config.embeddingModel || process.env.EMBEDDING_MODEL || 'nomic-embed-text:v1.5';
    this.dimension = config.dimension || Number(process.env.EMBEDDING_DIMENSION) || 768;
    this.batchSize = config.batchSize || 10;
    this.maxTextLength = config.maxTextLength ?? 8000;
    if (!Number.isSafeInteger(this.maxTextLength) || this.maxTextLength < 1) {
      throw new Error('maxTextLength must be a positive safe integer');
    }
  }

  validateText(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('text must be a non-empty string');
    }
    if (text.length > this.maxTextLength) {
      throw Object.assign(new Error(`Embedding input exceeds the provider limit of ${this.maxTextLength} characters; no text was truncated. Split the source during ingestion or reduce the query.`), {
        code: 'EMBEDDING_INPUT_TOO_LARGE', statusCode: 413,
        limit: this.maxTextLength, inputLength: text.length
      });
    }
  }

  validateTexts(texts) {
    if (!Array.isArray(texts) || texts.length === 0) throw new Error('texts must be a non-empty array');
    texts.forEach(text => this.validateText(text));
  }

  async embed(text, preferredHost = null) {
    this.validateText(text);
    return this._requestEmbedding(text, preferredHost);
  }

  async embedBatch(texts, preferredHost = null) {
    this.validateTexts(texts);

    const results = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResults = await Promise.all(
        batch.map((text) => this.embed(text, preferredHost))
      );
      results.push(...batchResults);
    }

    return results;
  }

  async _requestEmbedding(text, preferredHost = null) {
    const body = {
      model: this.model,
      prompt: text,
    };

    if (preferredHost) {
      body.ollamaHost = preferredHost;
    }

    try {
      const response = await fetchWithTimeout(`${this.coreProxyUrl}/api/inference/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, EMBEDDING_TIMEOUT, {
        expectedOrigins: [this.coreProxyUrl],
        operationId: SERVICE_OUTBOUND_OPERATION_IDS.CORE_EMBED,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw Object.assign(new Error(`Core embed proxy error: ${response.status} - ${errorText}`),
          [400, 413].includes(response.status) ? { code: 'EMBEDDING_INPUT_REJECTED', statusCode: response.status } : {});
      }

      const data = await response.json();

      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid response from core embed proxy');
      }

      return data.embedding;
    } catch (error) {
      logger.error('Error generating embedding via core proxy', { error: error.message });
      throw Object.assign(new Error(`Failed to generate embedding: ${error.message}`, { cause: error }),
        error.code ? { code: error.code, statusCode: error.statusCode } : {});
    }
  }

  getDimension() {
    return this.dimension;
  }

  getStatusInfo() {
    return {
      provider: this.name,
      model: this.model,
      dimension: this.dimension,
      endpoint: this.coreProxyUrl,
      route: '/api/inference/embed',
      inputLimit: { unit: 'characters', maximum: this.maxTextLength, source: 'provider', overflow: 'reject' }
    };
  }

  async testConnection() {
    try {
      const embedding = await this.embed('test');
      return Array.isArray(embedding) && embedding.length === this.dimension;
    } catch (error) {
      logger.error('Embeddings connection test failed', {
        provider: this.name,
        error: error.message
      });
      return false;
    }
  }

  destroy() {}
}

module.exports = CoreProxyProvider;
