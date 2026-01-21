# Repo Watcher

## Overview

Repo Watcher is an automated code quality monitoring system that continuously scans your repository for structural anomalies, missing tests, documentation issues, and code duplication. It provides a dedicated dashboard UI with real-time status updates and trend analysis.

## Features

### Detection Modules

1. **Missing Tests**
   - Scans `src/`, `routes/`, `models/` for source files
   - Checks for corresponding test files in `tests/` or `__tests__/`
   - Reports files without test coverage
   - Confidence scoring based on file size and location

2. **Documentation Duplication**
   - Scans all `.md` files
   - Detects exact duplicates using content hashing
   - Identifies stale or conflicting documentation
   - Provides path references to duplicate sources

3. **Code Duplication**
   - Analyzes JavaScript/TypeScript files
   - Detects duplicate 10-line code blocks
   - Uses rolling hash for efficient comparison
   - Reports duplicate segments with line numbers

4. **Architecture Violations**
   - Checks for missing critical paths (README, docs/, src/, etc.)
   - Detects unexpected top-level directories
   - Validates project structure conventions
   - Flags structural drift from best practices

5. **Missing Documentation**
   - Analyzes doc-to-code ratio
   - Expects ~1 doc per 5 route files
   - Suggests documentation priorities
   - Tracks documentation coverage percentage

### Severity Levels

- **Fail** (Red): Critical issues requiring immediate attention
  - Missing critical paths (README, package.json)
  - Massive duplication spikes
  - Architecture violations

- **Warn** (Yellow): Issues that should be addressed
  - Missing tests
  - Moderate duplication
  - Documentation gaps

- **Info** (Blue): Advisory notices
  - Structural drift
  - Code duplication in non-critical files

## Architecture

### Components

```
Frontend (Dashboard)
└─> /public/repoWatcher.html
    ├─ Status card with severity indicator
    ├─ Summary statistics grid
    ├─ Filterable findings list
    └─ Trend charts (Chart.js)

Backend (Service Layer)
└─> /src/services/repoWatcherService.js
    ├─ Filesystem scanner
    ├─ Detection modules (5 types)
    ├─ Snapshot builder
    └─ Summary calculator

Data Layer
└─> /models/RepoScan.js
    ├─ Scan metadata
    ├─ Findings array
    ├─ Summary statistics
    └─ File snapshot

API Layer
└─> /routes/repoWatcher.js
    ├─ GET  /api/repoWatcher/status
    ├─ POST /api/repoWatcher/scan
    ├─ GET  /api/repoWatcher/trends
    └─ GET  /api/repoWatcher/history
```

### Data Flow

```
1. Trigger (Manual or Scheduled)
   ↓
2. Filesystem Walk
   ↓ (filters ignore patterns)
3. Build Snapshot
   ↓ (file metadata: path, size, mtime, hash)
4. Run Detection Modules
   ↓ (5 parallel checks)
5. Calculate Summary & Status
   ↓
6. Save to MongoDB (RepoScan collection)
   ↓
7. Return Results to Dashboard
   ↓
8. Render UI with Findings & Trends
```

## Installation & Setup

### 1. Seed the Persona

```bash
node scripts/seed-persona.js personas/repo_watcher.json
```

This creates the `repo_watcher` persona with dashboard UI configuration.

### 2. Configure Environment

Add to `.env`:

```bash
# Optional: Override default repo path
REPO_WATCHER_PATH=/path/to/your/repo

# Default: uses process.cwd() (current working directory)
```

### 3. Restart Server

```bash
npm start
```

The repoWatcher routes will be mounted at `/api/repoWatcher/*`.

### 4. Access Dashboard

Navigate to: `http://localhost:3080/repoWatcher.html`

## Usage

### Manual Scan

Click the **"Scan Now"** button in the dashboard, or trigger via API:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3080/api/repoWatcher/scan
```

### View Status

The dashboard auto-refreshes every 30 seconds. Status indicator shows:
- 🟢 **OK**: All clear, no critical issues
- 🟡 **WARN**: Warnings detected, review findings
- 🔴 **FAIL**: Critical issues found, immediate action required

### Filter Findings

Use the filter buttons to view:
- **All**: Show all findings
- **Failures**: Critical issues only
- **Warnings**: Warning-level issues
- **Info**: Advisory notices

### Trend Analysis

Click trend buttons to view historical data:
- **Duplication**: Track duplicate code/docs over time
- **Test Coverage**: Monitor missing tests trend
- **Documentation**: Track doc coverage percentage

## API Reference

### GET /api/repoWatcher/status

Get current scan status and latest findings.

**Response:**
```json
{
  "status": "warn",
  "summary": {
    "totalFiles": 342,
    "failures": 0,
    "warnings": 12,
    "infos": 5,
    "testCoverage": 78,
    "duplicationRate": 3,
    "docCoverage": 42
  },
  "findings": [...],
  "lastScan": "2025-01-21T14:32:15Z",
  "nextScan": null
}
```

### POST /api/repoWatcher/scan

Trigger a new repository scan.

**Response:**
```json
{
  "status": "success",
  "data": {
    "status": "ok",
    "summary": {...},
    "findings": [...],
    "scanDuration": 12453
  }
}
```

### GET /api/repoWatcher/trends

Get historical trend data for charts.

**Query Parameters:**
- `limit` - Number of historical scans to include (default: 10)

**Response:**
```json
{
  "timestamps": ["1/15", "1/16", "1/17", ...],
  "duplication": [5, 4, 6, ...],
  "tests": [12, 10, 8, ...],
  "docs": [3, 3, 2, ...]
}
```

### GET /api/repoWatcher/history

Get paginated scan history.

**Query Parameters:**
- `limit` - Results per page (default: 20)
- `skip` - Results to skip for pagination (default: 0)

**Response:**
```json
{
  "status": "success",
  "data": {
    "scans": [...],
    "total": 45,
    "page": 1,
    "pages": 3
  }
}
```

## Configuration

### Ignore Patterns

Edit `/src/services/repoWatcherService.js` to customize:

```javascript
this.ignorePatterns = [
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  // Add custom patterns
];
```

### Critical Paths

Define required files/directories:

```javascript
this.criticalPaths = [
  'README.md',
  'package.json',
  'docs',
  'src',
  // Add your critical paths
];
```

### Detection Thresholds

Adjust sensitivity in detection modules:

```javascript
// Minimum file size for test detection
if (file.size > 100) { ... }

// Minimum content length for duplication
if (normalized.length < 100) continue;

// Code block size for duplication detection
const block = lines.slice(i, i + 10);
```

## Multi-Tenancy Support

Repo Watcher respects workspace context:

```javascript
// Scans are workspace-scoped
const scan = new RepoScan({
  workspaceId: req.workspace?._id,
  repoPath,
  // ...
});

// Queries filter by workspace
const query = { repoPath };
if (workspaceId) {
  query.workspaceId = workspaceId;
}
```

Multiple workspaces can scan the same repository with isolated results.

## Performance

### Scan Performance

- **Small repos** (<500 files): ~2-5 seconds
- **Medium repos** (500-2000 files): ~5-15 seconds
- **Large repos** (2000+ files): ~15-30 seconds

### Optimization Tips

1. **Add ignore patterns** for build artifacts and dependencies
2. **Increase block sizes** for code duplication (reduces sensitivity)
3. **Skip small files** (< 100 bytes) in detection modules
4. **Limit trend history** to recent scans (default: 10)

### Database Impact

- Each scan creates one `RepoScan` document
- Findings stored as embedded array (no separate collection)
- Indexes on `repoPath`, `scannedAt`, `workspaceId`
- Old scans can be pruned periodically

## Integration

### N8N Workflows

Create scheduled workflow for automated scanning:

```json
{
  "name": "SBQC - N2.x Repo Watcher",
  "nodes": [
    {
      "type": "n8n-nodes-base.scheduleTrigger",
      "parameters": {
        "rule": { "interval": [{ "field": "hours", "hours": 1 }] }
      }
    },
    {
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "method": "POST",
        "url": "http://192.168.2.33:3080/api/repoWatcher/scan",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth"
      }
    }
  ]
}
```

### Slack/Email Alerts

Hook into scan completion for notifications:

```javascript
// In repoWatcherService.js after scan completes
if (scan.status === 'fail') {
  await notifySlack({
    status: 'fail',
    failures: scan.summary.failures,
    warnings: scan.summary.warnings
  });
}
```

## Troubleshooting

### Common Issues

**"No scans yet" on dashboard**
- Trigger manual scan via "Scan Now" button
- Check MongoDB connection and `RepoScan` collection
- Verify `REPO_WATCHER_PATH` is correct

**Scan takes too long**
- Check ignore patterns (ensure node_modules excluded)
- Reduce detection scope (skip small files)
- Check file system permissions

**Missing findings expected**
- Adjust detection thresholds
- Verify test file patterns match your conventions
- Check critical paths configuration

**Dashboard not loading**
- Ensure persona is seeded: `node scripts/seed-persona.js personas/repo_watcher.json`
- Check browser console for errors
- Verify authentication token

### Debug Mode

Enable detailed logging:

```javascript
// In repoWatcherService.js
logger.setLevel('debug');
```

## Future Enhancements

- [ ] Semantic code analysis (AST-based duplication detection)
- [ ] Failing test detection (CI integration)
- [ ] Documentation coherence checks (embeddings/RAG)
- [ ] Real-time file watching (vs scheduled scans)
- [ ] Custom detection rules (user-defined patterns)
- [ ] Remediation suggestions (AI-powered fixes)
- [ ] GitHub PR integration (scan on PR creation)
- [ ] Notification webhooks (Slack, Discord, email)

## Related Documentation

- [Persona UI Architecture](../architecture/PERSONA_UI_ARCHITECTURE.md)
- [Persona UI Implementation Guide](../architecture/PERSONA_UI_IMPLEMENTATION_GUIDE.md)
- [Multi-Tenancy](../architecture/MULTI_TENANCY.md)
- [Testing Patterns](../patterns/TESTING_PATTERNS.md)
