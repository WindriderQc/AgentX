/**
 * Repo Watcher Service
 *
 * Orchestrates file snapshot building, detection module dispatch, and
 * scan record persistence. Detection logic lives in repoWatcherDetectors.js.
 *
 * Singleton: call getRepoWatcherService() to get the shared instance.
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const RepoScan = require('../../models/RepoScan');
const logger = require('../../config/logger');

const {
  TEST_PATTERNS,
  DOC_PATTERNS,
  CRITICAL_PATHS,
  detectMissingTests,
  detectDocDuplication,
  detectCodeDuplication,
  detectArchitectureIssues,
  detectMissingDocs,
  detectConventionViolations,
  calculateSummary
} = require('./repoWatcherDetectors');

class RepoWatcherService {
  constructor() {
    this.ignorePatterns = [
      'node_modules', 'dist', 'build', '.git', '.next', 'coverage',
      '.DS_Store', '*.log', '.env', 'package-lock.json', 'yarn.lock',
      'test-results', 'playwright-report', '.backups', 'archive',
      '*.webm', '*.zip', '*.gz', '*.bin', '*.dat', '*.mmap'
    ];
    this.criticalPaths = CRITICAL_PATHS;
    this.testPatterns  = TEST_PATTERNS;
    this.docPatterns   = DOC_PATTERNS;
  }

  /**
   * Perform a full repository scan.
   */
  async scan(repoPath, workspaceId = null) {
    const startTime = Date.now();
    logger.info(`Starting repo scan: ${repoPath}`);

    try {
      const context  = await this.loadProjectContext(repoPath);
      const snapshot = await this.buildSnapshot(repoPath);

      const findings = [];
      findings.push(...await detectMissingTests(snapshot,       { testPatterns: this.testPatterns }));
      findings.push(...await detectDocDuplication(snapshot,     { docPatterns:  this.docPatterns }));
      findings.push(...await detectCodeDuplication(snapshot));
      findings.push(...await detectArchitectureIssues(snapshot, repoPath, { criticalPaths: this.criticalPaths }));
      findings.push(...await detectMissingDocs(snapshot,        repoPath, { docPatterns: this.docPatterns }));
      if (context) {
        findings.push(...await detectConventionViolations(snapshot, repoPath, context));
      }

      const summary = calculateSummary(snapshot, findings, {
        docPatterns:  this.docPatterns,
        testPatterns: this.testPatterns
      });

      const scan = new RepoScan({
        workspaceId,
        repoPath,
        status: 'ok',
        scanDuration: Date.now() - startTime,
        summary,
        findings,
        snapshot: {
          fileCount:   snapshot.files.length,
          totalSize:   snapshot.files.reduce((sum, f) => sum + f.size, 0),
          fileTypes:   this.countFileTypes(snapshot.files),
          directories: [...new Set(snapshot.files.map(f => path.dirname(f.path)))]
        },
        scannedAt: new Date()
      });
      scan.calculateStatus();
      await scan.save();

      logger.info(`Scan completed in ${scan.scanDuration}ms: ${findings.length} findings`);
      return {
        status:      scan.status,
        summary:     scan.summary,
        findings:    scan.findings,
        scanDuration: scan.scanDuration,
        lastScan:    scan.scannedAt
      };
    } catch (error) {
      logger.error('Scan failed', { error: error.message, repoPath });
      throw error;
    }
  }

  /**
   * Walk the repository and build a flat file list.
   */
  async buildSnapshot(repoPath) {
    const files = [];
    const walk = async (dir) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(repoPath, fullPath);
          if (this.shouldIgnore(relativePath)) continue;
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            const stats = await fs.stat(fullPath);
            files.push({ path: relativePath, fullPath, size: stats.size, mtime: stats.mtime, ext: path.extname(entry.name) });
          }
        }
      } catch (error) {
        logger.warn(`Failed to walk directory: ${dir}`, { error: error.message });
      }
    };
    await walk(repoPath);
    return { files, timestamp: new Date() };
  }

  /** Returns true if this relative path should be excluded from scanning. */
  shouldIgnore(relativePath) {
    return this.ignorePatterns.some(pattern => {
      if (pattern.includes('*')) {
        return new RegExp(pattern.replace(/\*/g, '.*')).test(relativePath);
      }
      return relativePath.includes(pattern);
    });
  }

  /**
   * Load project context from CLAUDE.md for convention-aware scanning.
   */
  async loadProjectContext(repoPath) {
    const claudeMdPath = path.join(repoPath, 'CLAUDE.md');
    try {
      const content = await fs.readFile(claudeMdPath, 'utf-8');
      logger.info('Loaded CLAUDE.md context for intelligent scanning');
      return {
        serviceOriented: /Service-Oriented Architecture/i.test(content),
        singletonPattern: /Singleton.*for Stateful Services/i.test(content),
        workspaceIsolation: /attachWorkspace|Workspace Isolation/i.test(content),
        errorHandling: /logger\.error.*res\.status\(500\)/i.test(content),
        routeDelegation: /Routes.*delegate.*services/i.test(content),
        testCoverage:    this.extractTestCoverageStandards(content),
        singletonServices: ['ragStore', 'embeddings', 'modelRouter', 'repoWatcherService'],
        rawContent: content
      };
    } catch (err) {
      logger.warn('Could not load CLAUDE.md context - using generic scanning', { error: err.message });
      return null;
    }
  }

  extractTestCoverageStandards(content) {
    const defaults = { services: 80, routes: 70, helpers: 90 };
    const match = content.match(/Services:\s*>?(\d+)%.*Routes:\s*>?(\d+)%.*Helpers:\s*>?(\d+)%/s);
    if (match) return { services: parseInt(match[1], 10), routes: parseInt(match[2], 10), helpers: parseInt(match[3], 10) };
    return defaults;
  }

  countFileTypes(files) {
    const types = {};
    files.forEach(f => { const ext = f.ext || 'no-ext'; types[ext] = (types[ext] || 0) + 1; });
    return types;
  }

  async getStatus(repoPath, workspaceId = null) {
    const scan = await RepoScan.getLatest(repoPath, workspaceId);
    if (!scan) {
      return { status: 'ok', summary: { totalFiles: 0, failures: 0, warnings: 0, infos: 0, testCoverage: 0, duplicationRate: 0, docCoverage: 0 }, findings: [], lastScan: null, nextScan: null };
    }
    return { status: scan.status, summary: scan.summary, findings: scan.findings, lastScan: scan.scannedAt, nextScan: null };
  }

  async getTrends(repoPath, workspaceId = null, limit = 10) {
    return RepoScan.getTrends(repoPath, workspaceId, limit);
  }
}

// Singleton instance
let instance = null;
function getRepoWatcherService() {
  if (!instance) instance = new RepoWatcherService();
  return instance;
}

module.exports = { getRepoWatcherService };
