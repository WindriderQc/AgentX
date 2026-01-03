const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const API_URL = 'http://localhost:3080/api/rag/ingest';
const WORKSPACE_ROOT = '/home/yb/codes';

// Directories to scan for documentation
const DOC_DIRS = [
    path.join(WORKSPACE_ROOT, 'AgentX', 'docs'),
    path.join(WORKSPACE_ROOT, 'DataAPI', 'docs'),
    path.join(WORKSPACE_ROOT, 'DataAPI', 'AGENTS.md'),
    path.join(WORKSPACE_ROOT, 'AgentX', 'README.md'),
    path.join(WORKSPACE_ROOT, 'DataAPI', 'README.md')
];

async function ingestFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const relativePath = filePath.replace(WORKSPACE_ROOT, '');
        const filename = path.basename(filePath);
        
        // Skip empty files
        if (!content.trim()) return;

        const payload = {
            source: 'codebase_docs',
            path: relativePath,
            title: filename,
            text: content,
            tags: ['documentation', 'codebase', path.basename(path.dirname(filePath))]
        };

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if (response.ok) {
            console.log(`✅ Ingested: ${relativePath}`);
        } else {
            console.error(`❌ Failed: ${relativePath} - ${data.message || JSON.stringify(data)}`);
        }
    } catch (error) {
        console.error(`❌ Error processing ${filePath}:`, error.message);
    }
}

async function scanDirectory(dir) {
    if (!fs.existsSync(dir)) return;

    const stat = fs.statSync(dir);
    if (stat.isFile()) {
        if (dir.endsWith('.md') || dir.endsWith('.txt')) {
            await ingestFile(dir);
        }
        return;
    }

    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            await scanDirectory(fullPath);
        } else if (file.endsWith('.md') || file.endsWith('.txt')) {
            await ingestFile(fullPath);
        }
    }
}

async function main() {
    console.log('🚀 Starting documentation ingestion...');
    
    for (const dir of DOC_DIRS) {
        console.log(`📂 Scanning: ${dir}`);
        await scanDirectory(dir);
    }
    
    console.log('✨ Ingestion complete!');
}

main();
