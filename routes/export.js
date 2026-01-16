const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const logger = require('../config/logger');

// Import RAG routes to access watcher instance
const ragRoutes = require('./rag');
let ragWatcherInstance = ragRoutes.ragWatcherInstance;

// POST /api/export-md-docs
// Triggers creation of ZIP archive containing all MD files from docs directory
router.post('/md-docs', async (req, res) => {
  try {
    const docsDir = path.join(__dirname, '..', 'docs');
    const exportsDir = path.join(__dirname, '..', 'exports');

    // Ensure exports directory exists
    await fs.mkdir(exportsDir, { recursive: true });

    // Generate timestamped filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipFilename = `md-docs-${timestamp}.zip`;
    const zipPath = path.join(exportsDir, zipFilename);

    // Run Python script to pack MD files
    const scriptPath = path.join(__dirname, '..', 'scripts', 'pack_md_docs.py');
    const command = `python3 "${scriptPath}" "${docsDir}" "${zipPath}"`;

    logger.info('Starting MD docs export', { docsDir, zipPath });

    const { stdout, stderr } = await execAsync(command, { timeout: 30000 }); // 30 second timeout

    if (stderr) {
      logger.warn('MD docs export warnings', { stderr });
    }

    // Check if ZIP was created successfully
    try {
      await fs.access(zipPath);
    } catch (error) {
      logger.error('ZIP file not created', { zipPath, error: error.message });
      return res.status(500).json({
        success: false,
        message: 'Failed to create ZIP archive'
      });
    }

    // Get file stats for response
    const stats = await fs.stat(zipPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    logger.info('MD docs export completed', {
      zipPath,
      fileSize: stats.size,
      fileSizeMB
    });

    res.json({
      success: true,
      message: 'MD documentation exported successfully',
      downloadUrl: `/exports/${zipFilename}`,
      fileSize: `${fileSizeMB} MB`,
      filePath: zipPath
    });

  } catch (error) {
    logger.error('MD docs export failed', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: 'Failed to export MD documentation',
      error: error.message
    });
  }
});

// GET /exports/:filename - Serve the ZIP file for download
router.get('/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '..', 'exports', filename);

    // Security check - only allow .zip files
    if (!filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Set headers for download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Stream the file
    const fileStream = require('fs').createReadStream(filePath);
    fileStream.pipe(res);

    // Clean up file after download (optional - could be done via cron job)
    fileStream.on('end', () => {
      // Delay cleanup to ensure download completes
      setTimeout(() => {
        fs.unlink(filePath).catch(err => {
          logger.warn('Failed to cleanup export file', { filePath, error: err.message });
        });
      }, 5000); // 5 seconds
    });

  } catch (error) {
    logger.error('File download failed', {
      filename: req.params.filename,
      error: error.message
    });
    res.status(500).json({ error: 'Download failed' });
  }
});

// POST /api/export/copy-to-rag
// Copies the contents of the latest MD docs ZIP to the RAG ingestion folder
router.post('/copy-to-rag', async (req, res) => {
  try {
    console.log('COPY-TO-RAG: Route called');

    const fs = require('fs').promises;
    const path = require('path');
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);

    const exportsDir = path.join(__dirname, '..', 'exports');
    const ragDir = '/mnt/datalake/RAG';

    console.log('COPY-TO-RAG: Checking exports dir:', exportsDir);

    // Find the latest ZIP file
    const files = await fs.readdir(exportsDir);
    const zipFiles = files.filter(f => f.endsWith('.zip') && f.startsWith('md-docs-')).sort();

    console.log('COPY-TO-RAG: Found ZIP files:', zipFiles);

    if (zipFiles.length === 0) {
      console.log('COPY-TO-RAG: No ZIP files found');
      return res.status(404).json({
        success: false,
        message: 'No MD docs ZIP file found. Please export first.'
      });
    }

    const latestZip = path.join(exportsDir, zipFiles[zipFiles.length - 1]);

    console.log('COPY-TO-RAG: Using ZIP file:', latestZip);

    // Ensure RAG directory exists
    await fs.mkdir(ragDir, { recursive: true });

    // Extract ZIP to RAG directory
    // Using unzip command since it's more reliable than node.js zip extraction
    const command = `/usr/bin/unzip -o "${latestZip}" -d "${ragDir}"`;

    console.log('COPY-TO-RAG: Executing command:', command);

    // Try synchronous exec first
    const { execSync } = require('child_process');
    let execResult = '';
    let execError = null;
    try {
      execResult = execSync(command, { timeout: 60000, encoding: 'utf8' });
      console.log('COPY-TO-RAG: Sync exec result:', execResult.substring(0, 200));
    } catch (syncError) {
      console.error('COPY-TO-RAG: Sync exec failed:', syncError.message);
      console.error('COPY-TO-RAG: Sync exec stderr:', syncError.stderr);
      console.error('COPY-TO-RAG: Sync exec status:', syncError.status);
      execError = syncError;
    }

    console.log('COPY-TO-RAG: Command execution completed');

    // If exec failed, return error
    if (execError) {
      return res.status(500).json({
        success: false,
        message: 'Failed to extract ZIP file',
        error: execError.message,
        stderr: execError.stderr
      });
    }

    // Check if files were actually extracted
    const extractedFiles = await fs.readdir(ragDir);
    console.log('COPY-TO-RAG: Files in RAG dir after extraction:', extractedFiles.length);

    // Trigger RAG watcher scan if available
    try {
      if (ragWatcherInstance) {
        logger.info('Triggering RAG watcher scan after file extraction');
        await ragWatcherInstance.initialScan();
      }
    } catch (watcherError) {
      logger.warn('Failed to trigger RAG watcher scan', { error: watcherError.message });
      // Don't fail the whole operation if watcher fails
    }

    logger.info('MD docs copied to RAG folder successfully', {
      zipFile: latestZip,
      ragDir,
      extractedFiles: extractedFiles.length,
      execResult: execResult.substring(0, 200)
    });

    console.log('COPY-TO-RAG: Success response sent');

    res.json({
      success: true,
      message: 'MD documentation copied to RAG folder successfully. n8n N2.3 workflow will process the files automatically.',
      zipFile: path.basename(latestZip),
      ragDir
    });

  } catch (error) {
    console.error('COPY-TO-RAG: Error occurred:', error.message);
    logger.error('Copy to RAG failed', {
      error: error.message,
      stack: error.stack,
      code: error.code,
      signal: error.signal,
      cmd: error.cmd
    });

    res.status(500).json({
      success: false,
      message: 'Failed to copy MD documentation to RAG folder',
      error: error.message
    });
  }
});

module.exports = router;