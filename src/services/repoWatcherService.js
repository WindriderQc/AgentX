const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const RepoScan = require('../../models/RepoScan');
const logger = require('../../config/logger');

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
      'yarn.lock',
      'test-results',
      'playwright-report',
      '.backups',
      'archive',
      '*.webm',
      '*.zip',
      '*.gz',
      '*.bin',
      '*.dat',
      '*.mmap'
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
      // Load project context from CLAUDE.md
      const context = await this.loadProjectContext(repoPath);

      // Build file snapshot
      const snapshot = await this.buildSnapshot(repoPath);

      // Run detection modules
      const findings = [];
      findings.push(...await this.detectMissingTests(snapshot));
      findings.push(...await this.detectDocDuplication(snapshot));
      findings.push(...await this.detectCodeDuplication(snapshot));
      findings.push(...await this.detectArchitectureIssues(snapshot, repoPath));
      findings.push(...await this.detectMissingDocs(snapshot, repoPath));

      // Context-aware detection (if CLAUDE.md available)
      if (context) {
        findings.push(...await this.detectConventionViolations(snapshot, repoPath, context));
      }

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
   * Load project context from CLAUDE.md
   */
  async loadProjectContext(repoPath) {
    const claudeMdPath = path.join(repoPath, 'CLAUDE.md');

    try {
      const content = await fs.readFile(claudeMdPath, 'utf-8');
      logger.info('Loaded CLAUDE.md context for intelligent scanning');

      return {
        // Architecture patterns
        serviceOriented: /Service-Oriented Architecture/i.test(content),
        singletonPattern: /Singleton.*for Stateful Services/i.test(content),

        // Critical patterns from docs
        workspaceIsolation: /attachWorkspace|Workspace Isolation/i.test(content),
        errorHandling: /logger\.error.*res\.status\(500\)/i.test(content),

        // Service-oriented flow
        routeDelegation: /Routes.*delegate.*services/i.test(content),

        // Test coverage standards (extract from content)
        testCoverage: this.extractTestCoverageStandards(content),

        // Stateful services that should use singleton
        singletonServices: ['ragStore', 'embeddings', 'modelRouter', 'repoWatcherService'],

        // Full content for advanced pattern matching
        rawContent: content
      };
    } catch (err) {
      logger.warn('Could not load CLAUDE.md context - using generic scanning', { error: err.message });
      return null;
    }
  }

  /**
   * Extract test coverage standards from CLAUDE.md
   */
  extractTestCoverageStandards(content) {
    const defaults = { services: 80, routes: 70, helpers: 90 };

    // Look for coverage standards in content
    const match = content.match(/Services:\s*>?(\d+)%.*Routes:\s*>?(\d+)%.*Helpers:\s*>?(\d+)%/s);

    if (match) {
      return {
        services: parseInt(match[1], 10),
        routes: parseInt(match[2], 10),
        helpers: parseInt(match[3], 10)
      };
    }

    return defaults;
  }

  /**
   * Check if code contains business logic (for route validation)
   */
  hasBusinessLogic(content) {
    // Routes should only do validation and delegate
    const businessLogicPatterns = [
      /await\s+\w+\.find\(/,          // Direct DB queries
      /await\s+\w+\.create\(/,
      /await\s+\w+\.update\(/,
      /await\s+\w+\.delete\(/,
      /for\s*\([^)]+\)\s*{[^}]{50,}/, // Complex loops
      /if\s*\([^)]+\)\s*{[^}]{100,}/  // Complex conditionals
    ];

    // Exceptions: These are OK in routes
    const exceptions = [
      /const service = get\w+Service\(\)/,  // Service retrieval
      /await service\./,                     // Service delegation
      /res\.json\(/,                         // Response handling
      /res\.status\(/
    ];

    const hasLogic = businessLogicPatterns.some(pattern => pattern.test(content));
    const hasException = exceptions.some(pattern => pattern.test(content));

    // Only flag if has logic AND doesn't have proper delegation
    return hasLogic && !hasException;
  }

  /**
   * Check if route has mutation operations
   */
  hasMutations(content) {
    const mutationPatterns = [
      /router\.post\(/,
      /router\.put\(/,
      /router\.patch\(/,
      /router\.delete\(/
    ];

    return mutationPatterns.some(pattern => pattern.test(content));
  }

  /**
   * Check if service uses singleton pattern
   */
  hasSingletonPattern(content) {
    // Pattern 1: Class-based singleton with getInstance/getXxx function
    const classBasedSingleton = [
      /let\s+\w*[Ii]nstance\w*\s*=\s*null/,         // let instance/ragStoreInstance/etc = null
      /if\s*\(!\w*[Ii]nstance\w*\)/,                 // if (!instance/!ragStoreInstance)
      /\w*[Ii]nstance\w*\s*=\s*new/,                 // instance = new / ragStoreInstance = new
      /return\s+\w*[Ii]nstance\w*/,                  // return instance/ragStoreInstance
      /function\s+get\w+\(/                           // function getXxxService(
    ];

    const classMatches = classBasedSingleton.filter(pattern => pattern.test(content)).length;

    // Pattern 2: Module-level singleton (stateful module with exported functions)
    const moduleSingleton = [
      /const\s+\w+_STATE\s*=/,                       // Module-level state constants
      /let\s+\w+_STATE\s*=/,
      /module\.exports\s*=\s*{/,                     // Exports functions, not class
      /=\s*require\(['"]/                             // Requires dependencies (any path)
    ];

    const moduleMatches = moduleSingleton.filter(pattern => pattern.test(content)).length;

    // Valid if either pattern is satisfied:
    // - Class-based: Need at least 4 out of 5 indicators
    // - Module-level: Need at least 3 out of 4 indicators
    return classMatches >= 4 || moduleMatches >= 3;
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
      f.size > 1000 // Only check files larger than 1KB
    );

    // Track code blocks by hash (simplified - not AST-based)
    const codeHashes = new Map();
    const reportedPairs = new Set(); // Track unique file pairs to avoid duplicate reports

    // Common patterns to skip
    const skipPatterns = [
      /^(const|let|var|import|require|module\.exports|export)/,
      /^\/\//,  // Comments
      /^\s*\*/, // JSDoc
      /^\/\*/,
      /^\s*{/,  // Opening braces
      /^\s*}/,  // Closing braces
      /^mongoose\.Schema/,
      /type:\s*(String|Number|Boolean|Date|ObjectId|Array)/
    ];

    for (const file of codeFiles) {
      try {
        const content = await fs.readFile(file.fullPath, 'utf-8');
        const lines = content.split('\n');

        // Check 20-line blocks (increased from 10)
        const blockSize = 20;
        for (let i = 0; i < lines.length - blockSize; i++) {
          const blockLines = lines.slice(i, i + blockSize);

          // Skip blocks that are mostly common patterns
          const significantLines = blockLines.filter(line => {
            const trimmed = line.trim();
            return trimmed.length > 0 &&
                   !skipPatterns.some(pattern => pattern.test(trimmed));
          });

          if (significantLines.length < 10) continue; // Need at least 10 significant lines

          const block = blockLines.join('\n').trim();
          if (block.length < 200) continue; // Skip trivial blocks (increased from 50)

          const hash = crypto.createHash('md5').update(block).digest('hex');

          if (codeHashes.has(hash)) {
            const duplicate = codeHashes.get(hash);
            if (duplicate.path !== file.path) {
              // Create unique pair key to avoid duplicate reports
              const pairKey = [duplicate.path, file.path].sort().join('::');

              if (!reportedPairs.has(pairKey)) {
                reportedPairs.add(pairKey);
                findings.push({
                  type: 'code_duplication',
                  severity: 'info',
                  path: file.path,
                  evidence: `Duplicate code block (${blockSize} lines) found in ${duplicate.path}:${duplicate.line}`,
                  confidence: 0.7,
                  metadata: {
                    duplicateOf: duplicate.path,
                    lineRange: [i + 1, i + blockSize],
                    blockSize
                  }
                });
              }
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
  async detectArchitectureIssues(snapshot, _repoPath) {
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
      'config', 'scripts', 'personas', '.github',
      'AgentC', 'data', 'logs', 'n8n_workflows', 'exports',
      'archive', 'lib', 'bin', 'migrations', 'seeds', 'utils',
      'middleware', 'controllers', 'views', 'assets',
      'qdrant', 'reports', 'storage'
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
  async detectMissingDocs(snapshot, _repoPath) {
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
   * Detect convention violations using CLAUDE.md context
   */
  async detectConventionViolations(snapshot, repoPath, context) {
    const findings = [];

    // 1. Check routes for Service-Oriented Architecture violations
    if (context.serviceOriented && context.routeDelegation) {
      const routeFiles = snapshot.files.filter(f =>
        f.path.startsWith('routes/') && f.ext === '.js' && f.size > 500
      );

      for (const file of routeFiles) {
        try {
          const content = await fs.readFile(file.fullPath, 'utf-8');

          // Check for business logic in routes
          if (this.hasBusinessLogic(content)) {
            findings.push({
              type: 'architecture_violation',
              severity: 'warn',
              path: file.path,
              evidence: 'Route contains business logic. Service-Oriented Architecture requires routes to delegate to services immediately.',
              confidence: 0.75,
              metadata: {
                pattern: 'Service-Oriented Architecture',
                reference: 'CLAUDE.md: Routes should only validate and delegate to services'
              }
            });
          }

          // Check workspace isolation for mutation endpoints
          if (context.workspaceIsolation && this.hasMutations(content)) {
            const hasWorkspaceMiddleware = content.includes('attachWorkspace') ||
                                          content.includes('optionalWorkspaceContext');
            const hasAuth = content.includes('requireAuth') || content.includes('apiKeyAuth');

            // Check if this is a global/admin-only route (exceptions to workspace isolation)
            const isGlobalRoute = content.includes('requireAdmin') ||
                                 file.path.includes('invitations') ||  // Public invitation acceptance
                                 file.path.includes('cache') ||        // Global cache management
                                 file.path.includes('model-registry') || // Global model catalog
                                 file.path.includes('models-unified') || // Global model aggregation
                                 file.path.includes('features');         // Global feature flags

            if (!hasWorkspaceMiddleware && hasAuth && !isGlobalRoute) {
              findings.push({
                type: 'architecture_violation',
                severity: 'warn',
                path: file.path,
                evidence: 'Mutation endpoint missing workspace middleware. Multi-tenancy requires attachWorkspace for data mutations.',
                confidence: 0.85,
                metadata: {
                  pattern: 'Workspace Isolation',
                  reference: 'CLAUDE.md: Use attachWorkspace for mutations, optionalWorkspaceContext for reads'
                }
              });
            }
          }

        } catch (error) {
          logger.warn(`Failed to check route conventions: ${file.path}`, { error: error.message });
        }
      }
    }

    // 2. Check services for singleton pattern (stateful services)
    if (context.singletonPattern) {
      const serviceFiles = snapshot.files.filter(f =>
        f.path.startsWith('src/services/') && f.ext === '.js' && f.size > 1000
      );

      for (const file of serviceFiles) {
        const baseName = path.basename(file.path, '.js');

        // Check if this service should use singleton pattern
        const shouldBeSingleton = context.singletonServices.some(name =>
          baseName.toLowerCase().includes(name.toLowerCase())
        );

        if (shouldBeSingleton) {
          try {
            const content = await fs.readFile(file.fullPath, 'utf-8');

            if (!this.hasSingletonPattern(content)) {
              findings.push({
                type: 'architecture_violation',
                severity: 'warn',
                path: file.path,
                evidence: `Stateful service "${baseName}" should use singleton pattern to maintain shared in-memory state.`,
                confidence: 0.7,
                metadata: {
                  pattern: 'Singleton Services',
                  reference: 'CLAUDE.md: Critical services use singletons to maintain shared in-memory state'
                }
              });
            }
          } catch (error) {
            logger.warn(`Failed to check service pattern: ${file.path}`, { error: error.message });
          }
        }
      }
    }

    // 3. Check error handling pattern
    if (context.errorHandling) {
      const allJsFiles = snapshot.files.filter(f =>
        (f.path.startsWith('routes/') || f.path.startsWith('src/services/')) &&
        f.ext === '.js' && f.size > 500
      );

      for (const file of allJsFiles) {
        try {
          const content = await fs.readFile(file.fullPath, 'utf-8');

          // Check for try-catch blocks
          const hasTryCatch = /try\s*{/.test(content);

          if (hasTryCatch) {
            // Check if error handling follows pattern: logger.error + res.status(500)
            const hasProperErrorHandling = /catch.*logger\.error.*res\.status\(500\)/s.test(content) ||
                                          /catch.*logger\.error.*throw/s.test(content);

            if (!hasProperErrorHandling) {
              findings.push({
                type: 'code_quality',
                severity: 'info',
                path: file.path,
                evidence: 'Error handling should follow pattern: logger.error() + res.status(500).json() or throw',
                confidence: 0.6,
                metadata: {
                  pattern: 'Error Handling',
                  reference: 'CLAUDE.md: Standard error handling pattern'
                }
              });
            }
          }
        } catch (error) {
          logger.warn(`Failed to check error handling: ${file.path}`, { error: error.message });
        }
      }
    }

    logger.info(`Context-aware scan detected ${findings.length} convention violations`);
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
    // Return plain object - Mongoose will convert to Map internally
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
