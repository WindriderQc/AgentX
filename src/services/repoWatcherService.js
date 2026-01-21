const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const RepoScan = require('../../models/RepoScan');
const logger = require('../../src/helpers/logger');

class RepoWatcherService {
  constructor() {
    this.ignorePatterns = [
      'node_modules',
      'dist',
      'build',
      '.git',
      '.next',
      'coverage',
      '.DS_Store',
      '*.log',
      '.env',
      'package-lock.json',
      'yarn.lock'
    ];

    this.criticalPaths = [
      'README.md',
      'package.json',
      'docs',
      'src',
      'models',
      'routes'
    ];

    this.testPatterns = [
      /\.test\.(js|ts|jsx|tsx)$/,
      /\.spec\.(js|ts|jsx|tsx)$/,
      /__tests__/
    ];

    this.docPatterns = [
      /\.md$/,
      /README/,
      /CONTRIBUTING/,
      /LICENSE/
    ];
  }

  /**
   * Perform a full repository scan
   * @param {string} repoPath - Path to repository root
   * @param {string} workspaceId - Optional workspace ID
   * @returns {Promise<Object>} Scan results
   */
  async scan(repoPath, workspaceId = null) {
    const startTime = Date.now();
    logger.info(`Starting repo scan: ${repoPath}`);

    try {
      // Build file snapshot
      const snapshot = await this.buildSnapshot(repoPath);

      // Run detection modules
      const findings = [];
      findings.push(...await this.detectMissingTests(snapshot));
      findings.push(...await this.detectDocDuplication(snapshot));
      findings.push(...await this.detectCodeDuplication(snapshot));
      findings.push(...await this.detectArchitectureIssues(snapshot, repoPath));
      findings.push(...await this.detectMissingDocs(snapshot, repoPath));

      // Calculate summary statistics
      const summary = this.calculateSummary(snapshot, findings);

      // Create scan record
      const scan = new RepoScan({
        workspaceId,
        repoPath,
        status: 'ok', // Will be calculated
        scanDuration: Date.now() - startTime,
        summary,
        findings,
        snapshot: {
          fileCount: snapshot.files.length,
          totalSize: snapshot.files.reduce((sum, f) => sum + f.size, 0),
          fileTypes: this.countFileTypes(snapshot.files),
          directories: [...new Set(snapshot.files.map(f => path.dirname(f.path)))]
        },
        scannedAt: new Date()
      });

      // Calculate status based on findings
      scan.calculateStatus();

      // Save to database
      await scan.save();

      logger.info(`Scan completed in ${scan.scanDuration}ms: ${findings.length} findings`);

      return {
        status: scan.status,
        summary: scan.summary,
        findings: scan.findings,
        scanDuration: scan.scanDuration,
        lastScan: scan.scannedAt
      };
    } catch (error) {
      logger.error('Scan failed', { error: error.message, repoPath });
      throw error;
    }
  }

  /**
   * Build snapshot of repository files
   */
  async buildSnapshot(repoPath) {
    const files = [];

    async function walk(dir) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(repoPath, fullPath);

          // Check ignore patterns
          if (this.shouldIgnore(relativePath)) {
            continue;
          }

          if (entry.isDirectory()) {
            await walk.call(this, fullPath);
          } else if (entry.isFile()) {
            const stats = await fs.stat(fullPath);
            files.push({
              path: relativePath,
              fullPath,
              size: stats.size,
              mtime: stats.mtime,
              ext: path.extname(entry.name)
            });
          }
        }
      } catch (error) {
        logger.warn(`Failed to walk directory: ${dir}`, { error: error.message });
      }
    }

    await walk.call(this, repoPath);

    return {
      files,
      timestamp: new Date()
    };
  }

  /**
   * Check if path should be ignored
   */
  shouldIgnore(relativePath) {
    return this.ignorePatterns.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(relativePath);
      }
      return relativePath.includes(pattern);
    });
  }

  /**
   * Detect missing tests
   */
  async detectMissingTests(snapshot) {
    const findings = [];
    const sourceFiles = snapshot.files.filter(f =>
      /\.(js|ts|jsx|tsx)$/.test(f.ext) &&
      (f.path.startsWith('src/') || f.path.startsWith('routes/') || f.path.startsWith('models/'))
    );

    const testFiles = snapshot.files.filter(f =>
      this.testPatterns.some(pattern => pattern.test(f.path))
    );

    // Map test files to source files
    const testedFiles = new Set();
    testFiles.forEach(test => {
      const baseName = test.path
        .replace(/\.test\.(js|ts|jsx|tsx)$/, '')
        .replace(/\.spec\.(js|ts|jsx|tsx)$/, '')
        .replace(/__tests__\//g, '');
      testedFiles.add(baseName);
    });

    // Find source files without tests
    for (const file of sourceFiles) {
      const basePath = file.path.replace(/\.(js|ts|jsx|tsx)$/, '');
      const hasTest = testedFiles.has(basePath) ||
                      testedFiles.has(path.basename(basePath));

      if (!hasTest && file.size > 100) { // Skip tiny files
        findings.push({
          type: 'missing_test',
          severity: 'warn',
          path: file.path,
          evidence: `No matching test file found in tests/ or __tests__/`,
          confidence: 0.75
        });
      }
    }

    return findings;
  }

  /**
   * Detect documentation duplication
   */
  async detectDocDuplication(snapshot) {
    const findings = [];
    const docFiles = snapshot.files.filter(f =>
      this.docPatterns.some(pattern => pattern.test(f.path))
    );

    // Hash content for comparison
    const contentHashes = new Map();

    for (const file of docFiles) {
      try {
        const content = await fs.readFile(file.fullPath, 'utf-8');
        const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();

        if (normalized.length < 100) continue; // Skip short files

        const hash = crypto.createHash('md5').update(normalized).digest('hex');

        if (contentHashes.has(hash)) {
          const duplicate = contentHashes.get(hash);
          findings.push({
            type: 'doc_duplication',
            severity: 'warn',
            path: file.path,
            evidence: `Duplicate content found in ${duplicate}`,
            confidence: 0.9,
            metadata: { duplicateOf: duplicate }
          });
        } else {
          contentHashes.set(hash, file.path);
        }
      } catch (error) {
        logger.warn(`Failed to read file: ${file.path}`, { error: error.message });
      }
    }

    return findings;
  }

  /**
   * Detect code duplication (simplified)
   */
  async detectCodeDuplication(snapshot) {
    const findings = [];
    const codeFiles = snapshot.files.filter(f =>
      /\.(js|ts|jsx|tsx)$/.test(f.ext) &&
      f.size > 500 // Only check files larger than 500 bytes
    );

    // Track code blocks by hash (simplified - not AST-based)
    const codeHashes = new Map();

    for (const file of codeFiles) {
      try {
        const content = await fs.readFile(file.fullPath, 'utf-8');
        const lines = content.split('\n');

        // Check 10-line blocks
        for (let i = 0; i < lines.length - 10; i++) {
          const block = lines.slice(i, i + 10).join('\n').trim();
          if (block.length < 50) continue; // Skip trivial blocks

          const hash = crypto.createHash('md5').update(block).digest('hex');

          if (codeHashes.has(hash)) {
            const duplicate = codeHashes.get(hash);
            if (duplicate.path !== file.path) {
              findings.push({
                type: 'code_duplication',
                severity: 'info',
                path: file.path,
                evidence: `Duplicate code block found in ${duplicate.path}:${duplicate.line}`,
                confidence: 0.7,
                metadata: { duplicateOf: duplicate.path, lineRange: [i + 1, i + 10] }
              });
            }
          } else {
            codeHashes.set(hash, { path: file.path, line: i + 1 });
          }
        }
      } catch (error) {
        logger.warn(`Failed to check code duplication: ${file.path}`, { error: error.message });
      }
    }

    return findings;
  }

  /**
   * Detect architecture violations
   */
  async detectArchitectureIssues(snapshot, repoPath) {
    const findings = [];

    // Check for missing critical paths
    for (const criticalPath of this.criticalPaths) {
      const exists = snapshot.files.some(f =>
        f.path === criticalPath || f.path.startsWith(criticalPath + '/')
      );

      if (!exists) {
        findings.push({
          type: 'architecture_violation',
          severity: 'fail',
          path: criticalPath,
          evidence: `Critical path missing: ${criticalPath}`,
          confidence: 1.0
        });
      }
    }

    // Detect unexpected top-level directories
    const topLevelDirs = new Set(
      snapshot.files
        .map(f => f.path.split('/')[0])
        .filter(d => !d.includes('.'))
    );

    const allowedTopLevel = [
      'src', 'models', 'routes', 'public', 'docs', 'test', 'tests',
      'config', 'scripts', 'personas', '.github'
    ];

    for (const dir of topLevelDirs) {
      if (!allowedTopLevel.includes(dir)) {
        findings.push({
          type: 'structural_drift',
          severity: 'info',
          path: dir,
          evidence: `Unexpected top-level directory: ${dir}`,
          confidence: 0.6
        });
      }
    }

    return findings;
  }

  /**
   * Detect missing documentation
   */
  async detectMissingDocs(snapshot, repoPath) {
    const findings = [];

    // Check for routes without documentation
    const routeFiles = snapshot.files.filter(f =>
      f.path.startsWith('routes/') && f.ext === '.js'
    );

    const docFiles = snapshot.files.filter(f =>
      f.path.startsWith('docs/') && this.docPatterns.some(p => p.test(f.path))
    );

    // Simple heuristic: expect at least 1 doc per 5 route files
    const expectedDocs = Math.ceil(routeFiles.length / 5);
    if (docFiles.length < expectedDocs) {
      findings.push({
        type: 'missing_docs',
        severity: 'warn',
        path: 'docs/',
        evidence: `Expected at least ${expectedDocs} documentation files, found ${docFiles.length}`,
        confidence: 0.5
      });
    }

    return findings;
  }

  /**
   * Calculate summary statistics
   */
  calculateSummary(snapshot, findings) {
    const sourceFiles = snapshot.files.filter(f =>
      /\.(js|ts|jsx|tsx)$/.test(f.ext) &&
      (f.path.startsWith('src/') || f.path.startsWith('routes/') || f.path.startsWith('models/'))
    );

    const testFiles = snapshot.files.filter(f =>
      this.testPatterns.some(pattern => pattern.test(f.path))
    );

    const docFiles = snapshot.files.filter(f =>
      this.docPatterns.some(pattern => pattern.test(f.path))
    );

    const missingTests = findings.filter(f => f.type === 'missing_test').length;
    const testCoverage = sourceFiles.length > 0
      ? Math.round(((sourceFiles.length - missingTests) / sourceFiles.length) * 100)
      : 0;

    const duplicationCount = findings.filter(f =>
      f.type.includes('duplication')
    ).length;
    const duplicationRate = snapshot.files.length > 0
      ? Math.round((duplicationCount / snapshot.files.length) * 100)
      : 0;

    return {
      totalFiles: snapshot.files.length,
      failures: findings.filter(f => f.severity === 'fail').length,
      warnings: findings.filter(f => f.severity === 'warn').length,
      infos: findings.filter(f => f.severity === 'info').length,
      testCoverage,
      duplicationRate,
      docCoverage: Math.round((docFiles.length / Math.max(sourceFiles.length, 1)) * 100)
    };
  }

  /**
   * Count file types
   */
  countFileTypes(files) {
    const types = {};
    files.forEach(f => {
      const ext = f.ext || 'no-ext';
      types[ext] = (types[ext] || 0) + 1;
    });
    return types;
  }

  /**
   * Get latest scan status
   */
  async getStatus(repoPath, workspaceId = null) {
    const scan = await RepoScan.getLatest(repoPath, workspaceId);

    if (!scan) {
      return {
        status: 'ok',
        summary: {
          totalFiles: 0,
          failures: 0,
          warnings: 0,
          infos: 0,
          testCoverage: 0,
          duplicationRate: 0,
          docCoverage: 0
        },
        findings: [],
        lastScan: null,
        nextScan: null
      };
    }

    return {
      status: scan.status,
      summary: scan.summary,
      findings: scan.findings,
      lastScan: scan.scannedAt,
      nextScan: null // Manual trigger only for now
    };
  }

  /**
   * Get trend data
   */
  async getTrends(repoPath, workspaceId = null, limit = 10) {
    return RepoScan.getTrends(repoPath, workspaceId, limit);
  }
}

// Singleton instance
let instance = null;

function getRepoWatcherService() {
  if (!instance) {
    instance = new RepoWatcherService();
  }
  return instance;
}

module.exports = { getRepoWatcherService };
