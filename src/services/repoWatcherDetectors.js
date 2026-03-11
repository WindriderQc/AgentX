/**
 * Repo Watcher Detectors
 *
 * Standalone detection functions extracted from RepoWatcherService.
 * Each function receives a snapshot and config params; no class dependency.
 *
 * Used by: repoWatcherService.js
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('../../config/logger');

// ── Shared constants ──────────────────────────────────────────

const TEST_PATTERNS = [
  /\.test\.(js|ts|jsx|tsx)$/,
  /\.spec\.(js|ts|jsx|tsx)$/,
  /__tests__/
];

const DOC_PATTERNS = [
  /\.md$/,
  /README/,
  /CONTRIBUTING/,
  /LICENSE/
];

const CRITICAL_PATHS = [
  'README.md', 'package.json', 'docs', 'src', 'models', 'routes'
];

const ALLOWED_TOP_LEVEL = [
  'src', 'models', 'routes', 'public', 'docs', 'test', 'tests',
  'config', 'scripts', 'personas', '.github',
  'AgentC', 'data', 'logs', 'n8n_workflows', 'exports',
  'archive', 'lib', 'bin', 'migrations', 'seeds', 'utils',
  'middleware', 'controllers', 'views', 'assets',
  'qdrant', 'reports', 'storage'
];

// ── Helper predicates (used by detectConventionViolations) ────

function hasBusinessLogic(content) {
  const businessLogicPatterns = [
    /await\s+\w+\.find\(/,
    /await\s+\w+\.create\(/,
    /await\s+\w+\.update\(/,
    /await\s+\w+\.delete\(/,
    /for\s*\([^)]+\)\s*{[^}]{50,}/,
    /if\s*\([^)]+\)\s*{[^}]{100,}/
  ];
  const exceptions = [
    /const service = get\w+Service\(\)/,
    /await service\./,
    /res\.json\(/,
    /res\.status\(/
  ];
  const hasLogic = businessLogicPatterns.some(p => p.test(content));
  const hasException = exceptions.some(p => p.test(content));
  return hasLogic && !hasException;
}

function hasMutations(content) {
  return [/router\.post\(/, /router\.put\(/, /router\.patch\(/, /router\.delete\(/]
    .some(p => p.test(content));
}

function hasSingletonPattern(content) {
  const classBasedSingleton = [
    /let\s+\w*[Ii]nstance\w*\s*=\s*null/,
    /if\s*\(!\w*[Ii]nstance\w*\)/,
    /\w*[Ii]nstance\w*\s*=\s*new/,
    /return\s+\w*[Ii]nstance\w*/,
    /function\s+get\w+\(/
  ];
  const moduleSingleton = [
    /const\s+\w+_STATE\s*=/,
    /let\s+\w+_STATE\s*=/,
    /module\.exports\s*=\s*{/,
    /=\s*require\(['"]/
  ];
  const classMatches = classBasedSingleton.filter(p => p.test(content)).length;
  const moduleMatches = moduleSingleton.filter(p => p.test(content)).length;
  return classMatches >= 4 || moduleMatches >= 3;
}

// ── Detection functions ───────────────────────────────────────

async function detectMissingTests(snapshot, { testPatterns = TEST_PATTERNS } = {}) {
  const findings = [];
  const sourceFiles = snapshot.files.filter(f =>
    /\.(js|ts|jsx|tsx)$/.test(f.ext) &&
    (f.path.startsWith('src/') || f.path.startsWith('routes/') || f.path.startsWith('models/'))
  );
  const testFiles = snapshot.files.filter(f =>
    testPatterns.some(p => p.test(f.path))
  );
  const testedFiles = new Set();
  testFiles.forEach(test => {
    const baseName = test.path
      .replace(/\.test\.(js|ts|jsx|tsx)$/, '')
      .replace(/\.spec\.(js|ts|jsx|tsx)$/, '')
      .replace(/__tests__\//g, '');
    testedFiles.add(baseName);
  });
  for (const file of sourceFiles) {
    const basePath = file.path.replace(/\.(js|ts|jsx|tsx)$/, '');
    const hasTest = testedFiles.has(basePath) || testedFiles.has(path.basename(basePath));
    if (!hasTest && file.size > 100) {
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

async function detectDocDuplication(snapshot, { docPatterns = DOC_PATTERNS } = {}) {
  const findings = [];
  const docFiles = snapshot.files.filter(f =>
    docPatterns.some(p => p.test(f.path))
  );
  const contentHashes = new Map();
  for (const file of docFiles) {
    try {
      const content = await fs.readFile(file.fullPath, 'utf-8');
      const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.length < 100) continue;
      const hash = crypto.createHash('md5').update(normalized).digest('hex');
      if (contentHashes.has(hash)) {
        const duplicate = contentHashes.get(hash);
        findings.push({
          type: 'doc_duplication', severity: 'warn', path: file.path,
          evidence: `Duplicate content found in ${duplicate}`,
          confidence: 0.9, metadata: { duplicateOf: duplicate }
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

async function detectCodeDuplication(snapshot) {
  const findings = [];
  const codeFiles = snapshot.files.filter(f =>
    /\.(js|ts|jsx|tsx)$/.test(f.ext) && f.size > 1000
  );
  const codeHashes = new Map();
  const reportedPairs = new Set();
  const skipPatterns = [
    /^(const|let|var|import|require|module\.exports|export)/,
    /^\/\//,
    /^\s*\*/,
    /^\/\*/,
    /^\s*{/,
    /^\s*}/,
    /^mongoose\.Schema/,
    /type:\s*(String|Number|Boolean|Date|ObjectId|Array)/
  ];

  for (const file of codeFiles) {
    try {
      const content = await fs.readFile(file.fullPath, 'utf-8');
      const lines = content.split('\n');
      const blockSize = 20;
      for (let i = 0; i < lines.length - blockSize; i++) {
        const blockLines = lines.slice(i, i + blockSize);
        const significantLines = blockLines.filter(line => {
          const trimmed = line.trim();
          return trimmed.length > 0 && !skipPatterns.some(p => p.test(trimmed));
        });
        if (significantLines.length < 10) continue;
        const block = blockLines.join('\n').trim();
        if (block.length < 200) continue;
        const hash = crypto.createHash('md5').update(block).digest('hex');
        if (codeHashes.has(hash)) {
          const duplicate = codeHashes.get(hash);
          if (duplicate.path !== file.path) {
            const pairKey = [duplicate.path, file.path].sort().join('::');
            if (!reportedPairs.has(pairKey)) {
              reportedPairs.add(pairKey);
              findings.push({
                type: 'code_duplication', severity: 'info', path: file.path,
                evidence: `Duplicate code block (${blockSize} lines) found in ${duplicate.path}:${duplicate.line}`,
                confidence: 0.7,
                metadata: { duplicateOf: duplicate.path, lineRange: [i + 1, i + blockSize], blockSize }
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

async function detectArchitectureIssues(snapshot, _repoPath, { criticalPaths = CRITICAL_PATHS } = {}) {
  const findings = [];
  for (const criticalPath of criticalPaths) {
    const exists = snapshot.files.some(f =>
      f.path === criticalPath || f.path.startsWith(criticalPath + '/')
    );
    if (!exists) {
      findings.push({
        type: 'architecture_violation', severity: 'fail', path: criticalPath,
        evidence: `Critical path missing: ${criticalPath}`, confidence: 1.0
      });
    }
  }
  const topLevelDirs = new Set(
    snapshot.files.map(f => f.path.split('/')[0]).filter(d => !d.includes('.'))
  );
  for (const dir of topLevelDirs) {
    if (!ALLOWED_TOP_LEVEL.includes(dir)) {
      findings.push({
        type: 'structural_drift', severity: 'info', path: dir,
        evidence: `Unexpected top-level directory: ${dir}`, confidence: 0.6
      });
    }
  }
  return findings;
}

async function detectMissingDocs(snapshot, _repoPath, { docPatterns = DOC_PATTERNS } = {}) {
  const findings = [];
  const routeFiles = snapshot.files.filter(f =>
    f.path.startsWith('routes/') && f.ext === '.js'
  );
  const docFiles = snapshot.files.filter(f =>
    f.path.startsWith('docs/') && docPatterns.some(p => p.test(f.path))
  );
  const expectedDocs = Math.ceil(routeFiles.length / 5);
  if (docFiles.length < expectedDocs) {
    findings.push({
      type: 'missing_docs', severity: 'warn', path: 'docs/',
      evidence: `Expected at least ${expectedDocs} documentation files, found ${docFiles.length}`,
      confidence: 0.5
    });
  }
  return findings;
}

async function detectConventionViolations(snapshot, repoPath, context) {
  const findings = [];

  // 1. SOA route checks
  if (context.serviceOriented && context.routeDelegation) {
    const routeFiles = snapshot.files.filter(f =>
      f.path.startsWith('routes/') && f.ext === '.js' && f.size > 500
    );
    for (const file of routeFiles) {
      try {
        const content = await fs.readFile(file.fullPath, 'utf-8');
        if (hasBusinessLogic(content)) {
          findings.push({
            type: 'architecture_violation', severity: 'warn', path: file.path,
            evidence: 'Route contains business logic. Service-Oriented Architecture requires routes to delegate to services immediately.',
            confidence: 0.75,
            metadata: { pattern: 'Service-Oriented Architecture', reference: 'CLAUDE.md: Routes should only validate and delegate to services' }
          });
        }
        if (context.workspaceIsolation && hasMutations(content)) {
          const hasWorkspaceMiddleware = content.includes('attachWorkspace') || content.includes('optionalWorkspaceContext');
          const hasAuth = content.includes('requireAuth') || content.includes('apiKeyAuth');
          const isGlobalRoute = content.includes('requireAdmin') ||
            file.path.includes('invitations') || file.path.includes('cache') ||
            file.path.includes('model-registry') || file.path.includes('models-unified') ||
            file.path.includes('features');
          if (!hasWorkspaceMiddleware && hasAuth && !isGlobalRoute) {
            findings.push({
              type: 'architecture_violation', severity: 'warn', path: file.path,
              evidence: 'Mutation endpoint missing workspace middleware. Multi-tenancy requires attachWorkspace for data mutations.',
              confidence: 0.85,
              metadata: { pattern: 'Workspace Isolation', reference: 'CLAUDE.md: Use attachWorkspace for mutations' }
            });
          }
        }
      } catch (error) {
        logger.warn(`Failed to check route conventions: ${file.path}`, { error: error.message });
      }
    }
  }

  // 2. Singleton pattern check for stateful services
  if (context.singletonPattern) {
    const serviceFiles = snapshot.files.filter(f =>
      f.path.startsWith('src/services/') && f.ext === '.js' && f.size > 1000
    );
    for (const file of serviceFiles) {
      const baseName = path.basename(file.path, '.js');
      const shouldBeSingleton = context.singletonServices.some(name =>
        baseName.toLowerCase().includes(name.toLowerCase())
      );
      if (shouldBeSingleton) {
        try {
          const content = await fs.readFile(file.fullPath, 'utf-8');
          if (!hasSingletonPattern(content)) {
            findings.push({
              type: 'architecture_violation', severity: 'warn', path: file.path,
              evidence: `Stateful service "${baseName}" should use singleton pattern.`,
              confidence: 0.7,
              metadata: { pattern: 'Singleton Services', reference: 'CLAUDE.md: Critical services use singletons' }
            });
          }
        } catch (error) {
          logger.warn(`Failed to check service pattern: ${file.path}`, { error: error.message });
        }
      }
    }
  }

  // 3. Error handling pattern check
  if (context.errorHandling) {
    const allJsFiles = snapshot.files.filter(f =>
      (f.path.startsWith('routes/') || f.path.startsWith('src/services/')) &&
      f.ext === '.js' && f.size > 500
    );
    for (const file of allJsFiles) {
      try {
        const content = await fs.readFile(file.fullPath, 'utf-8');
        const hasTryCatch = /try\s*{/.test(content);
        if (hasTryCatch) {
          const hasProperErrorHandling = /catch.*logger\.error.*res\.status\(500\)/s.test(content) ||
            /catch.*logger\.error.*throw/s.test(content);
          if (!hasProperErrorHandling) {
            findings.push({
              type: 'code_quality', severity: 'info', path: file.path,
              evidence: 'Error handling should follow pattern: logger.error() + res.status(500).json() or throw',
              confidence: 0.6,
              metadata: { pattern: 'Error Handling', reference: 'CLAUDE.md: Standard error handling pattern' }
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

// ── Summary helper ────────────────────────────────────────────

function calculateSummary(snapshot, findings, { docPatterns = DOC_PATTERNS, testPatterns = TEST_PATTERNS } = {}) {
  const sourceFiles = snapshot.files.filter(f =>
    /\.(js|ts|jsx|tsx)$/.test(f.ext) &&
    (f.path.startsWith('src/') || f.path.startsWith('routes/') || f.path.startsWith('models/'))
  );
  const docFiles = snapshot.files.filter(f => docPatterns.some(p => p.test(f.path)));
  const missingTests = findings.filter(f => f.type === 'missing_test').length;
  const testCoverage = sourceFiles.length > 0
    ? Math.round(((sourceFiles.length - missingTests) / sourceFiles.length) * 100) : 0;
  const duplicationCount = findings.filter(f => f.type.includes('duplication')).length;
  const duplicationRate = snapshot.files.length > 0
    ? Math.round((duplicationCount / snapshot.files.length) * 100) : 0;
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

module.exports = {
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
};
