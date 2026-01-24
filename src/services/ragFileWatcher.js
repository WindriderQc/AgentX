/**
 * RAG File Watcher Service
 *
 * Monitors the RAG folder for file changes and automatically:
 * - Ingests new MD files
 * - Validates file integrity
 * - Cleans up obsolete documents
 * - Updates manifests
 */

const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getRagStore } = require('../services/ragStore');
const RagManifest = require('../../models/RagManifest');
const logger = require('../../config/logger');
const { systemEvents } = require('../app');

class RagFileWatcher {
  constructor(config = {}) {
    this.ragDir = config.ragDir || '/mnt/datalake/RAG';
    this.ragStore = getRagStore(config.ragStore);
    this.source = config.source || 'rag-folder';
    this.root = config.root || this.ragDir;
    this.watcher = null;
    this.isProcessing = false;
    this.processingQueue = new Set();
    this.manifestUpdateInterval = config.manifestUpdateInterval || 300000; // 5 minutes
    this.manifestUpdateTimer = null;

    // Lightweight runtime telemetry for UI/status endpoints (no external deps)
    this.startedAt = new Date().toISOString();
    this.lastScanAt = null;
    this.lastManifestUpdateAt = null;
    this.lastCleanupAt = null;
    this.lastFileProcessedAt = null;
    this.filesProcessed = 0;
    this.lastScanTotals = { totalFiles: 0, mdFiles: 0 };
    this.lastManifestStats = { fileCount: 0, totalBytes: 0 };
    this.lastError = null;

    // Bind methods
    this.onFileAdded = this.onFileAdded.bind(this);
    this.onFileChanged = this.onFileChanged.bind(this);
    this.onFileRemoved = this.onFileRemoved.bind(this);
    this.processManifestUpdate = this.processManifestUpdate.bind(this);
  }

  /**
   * Start the file watcher
   */
  async start() {
    try {
      logger.info('Starting RAG file watcher', { ragDir: this.ragDir });

      // Ensure RAG directory exists
      await fs.mkdir(this.ragDir, { recursive: true });

      // Initialize watcher
      this.watcher = chokidar.watch(this.ragDir, {
        persistent: true,
        ignoreInitial: false, // Process existing files on startup
        awaitWriteFinish: {
          stabilityThreshold: 2000,
          pollInterval: 100
        },
        ignored: [
          /(^|[\/\\])\../, // Ignore dot files
          '**/*.tmp',      // Ignore temp files
          '**/*.bak',      // Ignore backup files
          '**/node_modules/**'
        ]
      });

      // Bind events
      this.watcher.on('add', this.onFileAdded);
      this.watcher.on('change', this.onFileChanged);
      this.watcher.on('unlink', this.onFileRemoved);

      // Start periodic manifest updates
      this.manifestUpdateTimer = setInterval(this.processManifestUpdate, this.manifestUpdateInterval);

      // Initial scan and manifest update
      await this.initialScan();

      logger.info('RAG file watcher started successfully');
    } catch (error) {
      this.lastError = { message: error.message, at: new Date().toISOString() };
      logger.error('Failed to start RAG file watcher', { error: error.message });
      throw error;
    }
  }

  /**
   * Stop the file watcher
   */
  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    if (this.manifestUpdateTimer) {
      clearInterval(this.manifestUpdateTimer);
      this.manifestUpdateTimer = null;
    }

    logger.info('RAG file watcher stopped');
  }

  /**
   * Initial scan of existing files
   */
  async initialScan() {
    try {
      logger.info('Performing initial RAG folder scan');

      const files = await this.scanDirectory(this.ragDir);
      const mdFiles = files.filter(file => file.endsWith('.md'));

      this.lastScanTotals = { totalFiles: files.length, mdFiles: mdFiles.length };
      logger.info('Initial scan complete', {
        totalFiles: files.length,
        mdFiles: mdFiles.length
      });

      // Process existing MD files
      for (const filePath of mdFiles) {
        await this.processFile(filePath, 'initial');
      }

      // Update manifest
      await this.updateManifest();
      this.lastScanAt = new Date().toISOString();

    } catch (error) {
      this.lastError = { message: error.message, at: new Date().toISOString() };
      logger.error('Initial scan failed', { error: error.message });
    }
  }

  /**
   * Recursively scan directory for files
   */
  async scanDirectory(dirPath) {
    const files = [];

    async function scan(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    await scan(dirPath);
    return files;
  }

  /**
   * Extract ZIP file to the RAG directory
   */
  async extractZipFile(zipPath) {
    try {
      logger.info('Extracting ZIP file', { zipPath });

      // Use system unzip command
      const unzip = spawn('unzip', ['-o', zipPath, '-d', this.ragDir], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        unzip.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        unzip.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        unzip.on('close', async (code) => {
          if (code === 0) {
            logger.info('ZIP extraction completed successfully', { zipPath });

            // Emit event for ZIP extraction
            systemEvents.emit('zip-extracted', {
              zipPath,
              extractedTo: this.ragDir,
              timestamp: new Date().toISOString()
            });

            // Clean up the ZIP file after successful extraction
            try {
              await fs.unlink(zipPath);
              logger.info('ZIP file cleaned up after extraction', { zipPath });
            } catch (cleanupError) {
              logger.warn('Failed to cleanup ZIP file', { zipPath, error: cleanupError.message });
            }

            resolve(stdout);
          } else {
            logger.error('ZIP extraction failed', { zipPath, code, stderr });
            reject(new Error(`unzip failed with code ${code}: ${stderr}`));
          }
        });

        unzip.on('error', (error) => {
          logger.error('ZIP extraction process error', { zipPath, error: error.message });
          reject(error);
        });
      });
    } catch (error) {
      logger.error('Failed to extract ZIP file', { zipPath, error: error.message });
      throw error;
    }
  }

  /**
   * Handle file added event
   */
  async onFileAdded(filePath) {
    // Handle ZIP files first
    if (filePath.endsWith('.zip')) {
      logger.info('ZIP file detected', { filePath });
      try {
        await this.extractZipFile(filePath);
        // After extraction, the watcher will detect the new MD files automatically
        return;
      } catch (error) {
        logger.error('Failed to process ZIP file', { filePath, error: error.message });
        return;
      }
    }

    // Handle MD files
    if (!filePath.endsWith('.md')) return;

    logger.info('MD file added', { filePath });
    await this.processFile(filePath, 'added');
  }

  /**
   * Handle file changed event
   */
  async onFileChanged(filePath) {
    if (!filePath.endsWith('.md')) return;

    logger.info('MD file changed', { filePath });
    await this.processFile(filePath, 'changed');
  }

  /**
   * Handle file removed event
   */
  async onFileRemoved(filePath) {
    if (!filePath.endsWith('.md')) return;

    logger.info('MD file removed', { filePath });
    await this.removeDocument(filePath);
  }

  /**
   * Process a file (ingest or update)
   */
  async processFile(filePath, eventType) {
    if (this.processingQueue.has(filePath)) {
      logger.debug('File already being processed', { filePath });
      return;
    }

    this.processingQueue.add(filePath);

    try {
      // Read file content
      const content = await fs.readFile(filePath, 'utf8');

      // Generate metadata
      const stats = await fs.stat(filePath);
      const relativePath = path.relative(this.ragDir, filePath);
      const sha256 = await this.calculateSHA256(filePath);

      const metadata = {
        source: this.source,
        path: relativePath,
        title: this.extractTitle(content, relativePath),
        tags: ['auto-ingested'],
        author: 'rag-watcher',
        createdAt: stats.birthtime,
        updatedAt: stats.mtime,
        sha256: sha256,
        size: stats.size
      };

      // Check if document already exists
      const existingDocs = await this.ragStore.listDocuments({
        source: this.source,
        path: relativePath
      });

      if (existingDocs.length > 0) {
        // Update existing document
        const existingDoc = existingDocs[0];

        // Check if content actually changed
        if (existingDoc.sha256 === sha256) {
          logger.debug('File unchanged, skipping update', { filePath, sha256 });
          return;
        }

        // Delete old document
        await this.ragStore.deleteDocument(existingDoc.documentId);
        logger.info('Deleted old document version', {
          documentId: existingDoc.documentId,
          filePath
        });
      }

      // Ingest new/updated document
      const result = await this.ragStore.upsertDocumentWithChunks(metadata, content);

      logger.info('Document processed successfully', {
        filePath,
        eventType,
        documentId: result.documentId,
        chunkCount: result.chunkCount,
        sha256
      });

      this.filesProcessed++;
      this.lastFileProcessedAt = new Date().toISOString();

      // Broadcast RAG activity event
      systemEvents.emit('rag-activity', {
        type: 'file-processed',
        eventType,
        filePath: relativePath,
        documentId: result.documentId,
        chunkCount: result.chunkCount,
        sha256,
        timestamp: new Date().toISOString()
      });

      // Trigger n8n webhook if configured
      await this.triggerIngestionWebhook(result);

    } catch (error) {
      this.lastError = { message: error.message, at: new Date().toISOString() };
      logger.error('Failed to process file', {
        filePath,
        eventType,
        error: error.message
      });
    } finally {
      this.processingQueue.delete(filePath);
    }
  }

  /**
   * Remove a document from RAG
   */
  async removeDocument(filePath) {
    try {
      const relativePath = path.relative(this.ragDir, filePath);

      const docs = await this.ragStore.listDocuments({
        source: this.source,
        path: relativePath
      });

      for (const doc of docs) {
        await this.ragStore.deleteDocument(doc.documentId);
        logger.info('Document removed from RAG', {
          documentId: doc.documentId,
          filePath
        });

        // Broadcast RAG activity event
        systemEvents.emit('rag-activity', {
          type: 'file-removed',
          filePath: relativePath,
          documentId: doc.documentId,
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      logger.error('Failed to remove document', {
        filePath,
        error: error.message
      });
    }
  }

  /**
   * Update the manifest with current file state
   */
  async updateManifest() {
    try {
      const files = await this.scanDirectory(this.ragDir);
      const mdFiles = files.filter(file => file.endsWith('.md'));

      const manifestFiles = [];

      for (const filePath of mdFiles) {
        try {
          const stats = await fs.stat(filePath);
          const relativePath = path.relative(this.ragDir, filePath);
          const sha256 = await this.calculateSHA256(filePath);

          manifestFiles.push({
            path: relativePath,
            sha256: sha256,
            size: stats.size,
            mtime: stats.mtime
          });
        } catch (error) {
          logger.warn('Failed to stat file for manifest', {
            filePath,
            error: error.message
          });
        }
      }

      const totalBytes = manifestFiles.reduce((sum, file) => sum + (file.size || 0), 0);
      this.lastManifestStats = { fileCount: manifestFiles.length, totalBytes };
      this.lastManifestUpdateAt = new Date().toISOString();

      // Update or create manifest
      const manifestData = {
        source: this.source,
        root: this.root,
        scanId: `scan-${Date.now()}`,
        generatedAt: new Date(),
        files: manifestFiles,
        stats: {
          fileCount: manifestFiles.length,
          totalBytes
        }
      };

      await RagManifest.findOneAndUpdate(
        { source: this.source, root: this.root },
        manifestData,
        { upsert: true, new: true }
      );

      logger.info('Manifest updated', {
        source: this.source,
        fileCount: manifestFiles.length,
        totalBytes
      });

    } catch (error) {
      this.lastError = { message: error.message, at: new Date().toISOString() };
      logger.error('Failed to update manifest', { error: error.message });
    }
  }

  /**
   * Process periodic manifest updates
   */
  async processManifestUpdate() {
    await this.updateManifest();

    // Also clean up obsolete documents
    await this.cleanupObsoleteDocuments();
  }

  /**
   * Clean up documents that no longer exist in filesystem
   */
  async cleanupObsoleteDocuments() {
    try {
      const docs = await this.ragStore.listDocuments({ source: this.source });
      const currentFiles = new Set(await this.scanDirectory(this.ragDir));

      let cleanedCount = 0;

      for (const doc of docs) {
        const fullPath = path.join(this.ragDir, doc.path);

        if (!currentFiles.has(fullPath)) {
          await this.ragStore.deleteDocument(doc.documentId);
          cleanedCount++;
          logger.info('Cleaned up obsolete document', {
            documentId: doc.documentId,
            path: doc.path
          });
        }
      }

      if (cleanedCount > 0) {
        logger.info('Obsolete document cleanup complete', { cleanedCount });

        // Broadcast cleanup event
        systemEvents.emit('rag-activity', {
          type: 'cleanup-completed',
          cleanedCount,
          timestamp: new Date().toISOString()
        });
      }

      this.lastCleanupAt = new Date().toISOString();

    } catch (error) {
      this.lastError = { message: error.message, at: new Date().toISOString() };
      logger.error('Failed to cleanup obsolete documents', { error: error.message });
    }
  }

  /**
   * Calculate SHA256 hash of file
   */
  async calculateSHA256(filePath) {
    const fileBuffer = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  }

  /**
   * Extract title from markdown content
   */
  extractTitle(content, filePath) {
    // Try to find title in first line
    const lines = content.split('\n');
    for (const line of lines.slice(0, 10)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        return trimmed.substring(2).trim();
      }
    }

    // Fallback to filename
    return path.basename(filePath, '.md');
  }

  /**
   * Trigger n8n ingestion webhook
   */
  async triggerIngestionWebhook(result) {
    try {
      const { triggerWebhook } = require('../utils/n8nWebhook');

      await triggerWebhook(
        process.env.N8N_WEBHOOK_RAG_INGEST || 'rag-ingest-webhook-id',
        {
          chatInput: `Auto-ingested: ${result.chunkCount} chunks from ${result.documentId}`,
          event: 'rag_auto_ingest',
          ingest: result,
          timestamp: new Date().toISOString(),
          source: 'rag-watcher'
        }
      );
    } catch (error) {
      logger.warn('Failed to trigger ingestion webhook', { error: error.message });
    }
  }

  /**
   * Get watcher status
   */
  getStatus() {
    const processingQueueSample = Array.from(this.processingQueue)
      .slice(0, 10)
      .map(filePath => path.relative(this.ragDir, filePath));

    return {
      isRunning: this.watcher !== null,
      ragDir: this.ragDir,
      source: this.source,
      root: this.root,
      startedAt: this.startedAt,
      lastScanAt: this.lastScanAt,
      lastManifestUpdateAt: this.lastManifestUpdateAt,
      lastCleanupAt: this.lastCleanupAt,
      lastFileProcessedAt: this.lastFileProcessedAt,
      filesProcessed: this.filesProcessed,
      lastScanTotals: this.lastScanTotals,
      lastManifestStats: this.lastManifestStats,
      lastError: this.lastError,
      processingQueueSize: this.processingQueue.size,
      processingQueueSample,
      manifestUpdateInterval: this.manifestUpdateInterval
    };
  }
}

module.exports = RagFileWatcher;
