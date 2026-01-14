#!/usr/bin/env node
/**
 * Update RAG Store from All Markdown Files
 *
 * Scans entire AgentX codebase for .md files and ingests them into RAG.
 * This complements the N2.3 n8n workflow which scans /mnt/datalake/RAG.
 *
 * Usage:
 *   node scripts/update-rag-from-md.js [--dry-run] [--source=SOURCE_NAME]
 *
 * Options:
 *   --dry-run    Show what would be ingested without actually doing it
 *   --source     Set custom source name (default: agentx-docs)
 *   --limit      Limit number of files to process (for testing)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Use native fetch in Node.js 18+
const fetch = globalThis.fetch || require('node-fetch');

// Configuration
const PROJECT_ROOT = path.join(__dirname, '..');
const API_URL = process.env.AGENTX_BASE_URL || 'http://localhost:3080';
const API_KEY = process.env.AGENTX_API_KEY || '';
const DEFAULT_SOURCE = 'agentx-docs';

// Parse CLI arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const sourceArg = args.find(a => a.startsWith('--source='));
const limitArg = args.find(a => a.startsWith('--limit='));
const source = sourceArg ? sourceArg.split('=')[1] : DEFAULT_SOURCE;
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

// Directories to exclude
const EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  'coverage',
  'dist',
  'build',
  '.next',
  'archive'
];

// Statistics
const stats = {
  found: 0,
  processed: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  errors: []
};

/**
 * Recursively find all .md files
 */
function findMarkdownFiles(dir, baseDir = dir) {
  const files = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip excluded directories
      if (entry.isDirectory() && EXCLUDE_DIRS.includes(entry.name)) {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...findMarkdownFiles(fullPath, baseDir));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const relativePath = path.relative(baseDir, fullPath);
        files.push({
          absolutePath: fullPath,
          relativePath: relativePath,
          filename: entry.name,
          size: fs.statSync(fullPath).size
        });
      }
    }
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err.message);
  }

  return files;
}

/**
 * Compute SHA256 hash of text
 */
function computeHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Ingest a single document to RAG
 */
async function ingestDocument(file, content) {
  const hash = computeHash(content);

  // Extract tags from path
  const pathParts = file.relativePath.split(path.sep);
  const tags = ['documentation', 'markdown'];

  // Add directory-based tags
  if (pathParts.includes('docs')) tags.push('docs');
  if (pathParts.includes('architecture')) tags.push('architecture');
  if (pathParts.includes('operations')) tags.push('operations');
  if (pathParts.includes('patterns')) tags.push('patterns');
  if (pathParts.includes('features')) tags.push('features');
  if (pathParts.includes('guides')) tags.push('guides');

  const payload = {
    source: source,
    path: file.relativePath,
    title: file.filename,
    text: content,
    hash: hash,
    tags: tags,
    metadata: {
      size: file.size,
      ingestedAt: new Date().toISOString(),
      ingestedBy: 'update-rag-from-md.js'
    }
  };

  if (isDryRun) {
    console.log(`[DRY RUN] Would ingest: ${file.relativePath} (${tags.join(', ')})`);
    return { status: 'dry-run', documentId: 'dry-run-' + hash.substring(0, 8) };
  }

  try {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (API_KEY) {
      headers['x-api-key'] = API_KEY;
    }

    const response = await fetch(`${API_URL}/api/rag/ingest`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    throw new Error(`Failed to ingest ${file.relativePath}: ${error.message}`);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║     AgentX RAG Update - Markdown Files                        ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No actual ingestion will occur\n');
  }

  console.log(`📁 Project root: ${PROJECT_ROOT}`);
  console.log(`🎯 Source: ${source}`);
  console.log(`🌐 API URL: ${API_URL}`);
  console.log(`🔑 API Key: ${API_KEY ? '***' + API_KEY.slice(-4) : 'Not set'}`);
  console.log('');

  // Find all markdown files
  console.log('🔍 Scanning for markdown files...');
  const files = findMarkdownFiles(PROJECT_ROOT);
  stats.found = files.length;

  console.log(`✅ Found ${files.length} markdown files\n`);

  if (files.length === 0) {
    console.log('No markdown files found. Exiting.');
    return;
  }

  // Apply limit if specified
  const filesToProcess = limit ? files.slice(0, limit) : files;

  if (limit) {
    console.log(`⚠️  Processing limited to ${limit} files\n`);
  }

  // Show directory breakdown
  console.log('📊 Directory breakdown (top 10):');
  const dirCount = {};
  files.forEach(f => {
    const dir = path.dirname(f.relativePath);
    dirCount[dir] = (dirCount[dir] || 0) + 1;
  });

  Object.entries(dirCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([dir, count]) => {
      console.log(`  ${count.toString().padStart(3)} files in ${dir}`);
    });

  console.log('');

  // Process each file
  console.log('📥 Ingesting files...\n');

  for (const file of filesToProcess) {
    stats.processed++;

    try {
      // Read file content
      const content = fs.readFileSync(file.absolutePath, 'utf8');

      // Skip empty files
      if (!content.trim()) {
        console.log(`⏭️  Skipped (empty): ${file.relativePath}`);
        stats.skipped++;
        continue;
      }

      // Ingest to RAG
      const result = await ingestDocument(file, content);

      if (result.status === 'created' || result.status === 'updated' || result.status === 'success' || result.documentId) {
        console.log(`✅ ${result.status || 'ingested'}: ${file.relativePath} (${result.chunkCount || 0} chunks)`);
        stats.success++;
      } else {
        console.log(`⚠️  Unknown status: ${file.relativePath}`);
        stats.failed++;
      }

      // Small delay to avoid overwhelming the API
      if (!isDryRun) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

    } catch (error) {
      console.error(`❌ Failed: ${file.relativePath} - ${error.message}`);
      stats.failed++;
      stats.errors.push({
        file: file.relativePath,
        error: error.message
      });
    }
  }

  // Print summary
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║     Summary                                                    ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log(`Found:      ${stats.found} files`);
  console.log(`Processed:  ${stats.processed} files`);
  console.log(`Success:    ${stats.success} files`);
  console.log(`Failed:     ${stats.failed} files`);
  console.log(`Skipped:    ${stats.skipped} files`);
  console.log('');

  if (stats.errors.length > 0) {
    console.log('❌ Errors:');
    stats.errors.forEach(err => {
      console.log(`  - ${err.file}: ${err.error}`);
    });
    console.log('');
  }

  // Output JSON for n8n integration
  const jsonOutput = {
    status: stats.failed > 0 ? 'partial' : 'success',
    timestamp: new Date().toISOString(),
    source: source,
    stats: stats,
    dryRun: isDryRun
  };

  console.log('📋 JSON Output:');
  console.log(JSON.stringify(jsonOutput, null, 2));

  // Exit with error code if there were failures
  if (stats.failed > 0 && !isDryRun) {
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
