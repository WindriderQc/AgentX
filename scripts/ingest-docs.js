const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

// --- Configuration ---
const PORT = process.env.PORT || 3080;
const API_URL = process.env.AGENTX_BASE_URL || `http://localhost:${PORT}`;
const INGEST_ENDPOINT = `${API_URL}/api/rag/ingest`;
const API_KEY = process.env.AGENTX_API_KEY || '';

const WORKSPACE_ROOT = '/home/yb/codes';
const AGENTX_ROOT = path.join(WORKSPACE_ROOT, 'AgentX');

// Parse CLI flags
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FULL_SCAN = args.includes('--full');
const JSON_OUTPUT = args.includes('--json');
const LIMIT = (() => {
    const idx = args.findIndex(a => a.startsWith('--limit='));
    return idx >= 0 ? parseInt(args[idx].split('=')[1], 10) : 0;
})();

// Directories to exclude from scanning
const EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'coverage', 'playwright-report',
    'test-results', '.backups', 'dist', 'build', 'qdrant_data',
    'qdrant', 'storage', 'exports', 'logs'
]);

// --- Scan Modes ---
// Default: docs/ folders + key files (backward compatible)
// --full:  entire AgentX codebase (all .md files)
function getScanTargets() {
    if (FULL_SCAN) {
        return [
            AGENTX_ROOT,
            path.join(WORKSPACE_ROOT, 'DataAPI')
        ];
    }
    // Original behavior: only docs folders + specific files
    return [
        path.join(AGENTX_ROOT, 'docs'),
        path.join(WORKSPACE_ROOT, 'DataAPI', 'docs'),
        path.join(WORKSPACE_ROOT, 'DataAPI', 'AGENTS.md'),
        path.join(AGENTX_ROOT, 'README.md'),
        path.join(WORKSPACE_ROOT, 'DataAPI', 'README.md')
    ];
}

// --- Auto-tagging based on path ---
function getAutoTags(filePath) {
    const rel = filePath.replace(WORKSPACE_ROOT + '/', '');
    const parts = rel.split('/');
    const tags = ['documentation', 'codebase'];
    const dir = path.basename(path.dirname(filePath));

    if (parts[0]) tags.push(parts[0].toLowerCase()); // agentx or dataapi
    if (dir && dir !== '.') tags.push(dir);

    // Category tags from path
    if (rel.includes('/architecture/'))  tags.push('architecture');
    if (rel.includes('/operations/'))    tags.push('operations');
    if (rel.includes('/patterns/'))      tags.push('patterns');
    if (rel.includes('/integrations/'))  tags.push('integrations');
    if (rel.includes('/guides/'))        tags.push('guides');
    if (rel.includes('/testing/'))       tags.push('testing');
    if (rel.includes('/AgentC/'))        tags.push('n8n', 'workflows');
    if (rel.includes('/personas/'))      tags.push('personas');
    if (rel.includes('/services/'))      tags.push('services');
    if (rel.includes('/reports/'))       tags.push('reports');

    return [...new Set(tags)]; // dedupe
}

// --- Deduplication via SHA256 ---
function contentHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// --- Ingestion ---
const stats = { scanned: 0, ingested: 0, skipped: 0, failed: 0, errors: [] };
const seenHashes = new Set();

function log(...messages) {
    if (!JSON_OUTPUT) console.log(...messages);
}

function logError(...messages) {
    if (!JSON_OUTPUT) console.error(...messages);
}

async function ingestFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const relativePath = filePath.replace(WORKSPACE_ROOT, '');
        const filename = path.basename(filePath);

        // Skip empty files
        if (!content.trim()) {
            stats.skipped++;
            return;
        }

        // Dedup within this run
        const hash = contentHash(content);
        if (seenHashes.has(hash)) {
            stats.skipped++;
            return;
        }
        seenHashes.add(hash);

        stats.scanned++;

        const payload = {
            source: FULL_SCAN ? 'agentx-complete' : 'codebase_docs',
            path: relativePath,
            title: filename,
            text: content,
            tags: getAutoTags(filePath)
        };

        if (DRY_RUN) {
            log(`[DRY RUN] ${relativePath} (${content.length} bytes, ${payload.tags.join(', ')})`);
            stats.ingested++;
            return;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (API_KEY) headers['x-api-key'] = API_KEY;

        const response = await fetch(INGEST_ENDPOINT, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (response.ok) {
            log(`✅ Ingested: ${relativePath}`);
            stats.ingested++;
        } else {
            logError(`❌ Failed: ${relativePath} - ${data.message || JSON.stringify(data)}`);
            stats.failed++;
            stats.errors.push({ path: relativePath, error: data.message });
        }
    } catch (error) {
        logError(`❌ Error processing ${filePath}:`, error.message);
        stats.failed++;
        stats.errors.push({ path: filePath, error: error.message });
    }
}

function scanDirectory(dir) {
    if (!fs.existsSync(dir)) return [];

    const stat = fs.statSync(dir);
    if (stat.isFile()) {
        if (dir.endsWith('.md') || dir.endsWith('.txt')) return [dir];
        return [];
    }

    let results = [];
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
        if (EXCLUDE_DIRS.has(entry)) continue;
        const fullPath = path.join(dir, entry);
        const entryStat = fs.statSync(fullPath);
        if (entryStat.isDirectory()) {
            results = results.concat(scanDirectory(fullPath));
        } else if (entry.endsWith('.md') || entry.endsWith('.txt')) {
            results.push(fullPath);
        }
    }
    return results;
}

async function main() {
    const mode = FULL_SCAN ? 'FULL CODEBASE' : 'DOCS ONLY';
    log(`🚀 Starting documentation ingestion (${mode})${DRY_RUN ? ' [DRY RUN]' : ''}...`);

    const targets = getScanTargets();
    let allFiles = [];

    for (const target of targets) {
        log(`📂 Scanning: ${target}`);
        allFiles = allFiles.concat(scanDirectory(target));
    }

    if (LIMIT > 0) {
        allFiles = allFiles.slice(0, LIMIT);
        log(`🔢 Limited to ${LIMIT} files`);
    }

    log(`📄 Found ${allFiles.length} files to process\n`);

    for (const file of allFiles) {
        await ingestFile(file);
    }

    if (JSON_OUTPUT) {
        console.log(JSON.stringify({
            status: stats.failed > 0 ? 'partial' : 'success',
            mode: FULL_SCAN ? 'full' : 'docs',
            dryRun: DRY_RUN,
            limit: LIMIT || null,
            scanned: stats.scanned,
            ingested: stats.ingested,
            skipped: stats.skipped,
            failed: stats.failed,
            errors: stats.errors
        }));
    } else {
        console.log(`\n✨ Ingestion complete!`);
        console.log(`   Scanned: ${stats.scanned} | Ingested: ${stats.ingested} | Skipped: ${stats.skipped} | Failed: ${stats.failed}`);

        if (stats.errors.length > 0) {
            console.log(`\n⚠️  Errors:`);
            stats.errors.forEach(e => console.log(`   - ${e.path}: ${e.error}`));
        }
    }

    if (!DRY_RUN && stats.failed > 0) {
        process.exitCode = 1;
    }
}

main();
