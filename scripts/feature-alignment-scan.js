#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { scanWorkspace } = require('../src/services/featureAlignmentScanner');
const { calculatePriority, FALSE_POSITIVE_ENDPOINTS, API_ONLY_ENDPOINTS } = require('../src/services/featureAlignmentPriority');

function parseArgs(argv) {
  const args = { root: process.cwd(), out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') {
      args.root = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '--out') {
      args.out = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function generateMarkdownReport(report, outFile, features) {
  let md = '# Feature Alignment Action Report\n\n';

  // Executive Summary
  const c = report.summary.counts;

  // Filter headless features to exclude API-only and complete
  // We use the 'priority' object calculated in the main loop
  const trulyHeadless = features.filter(f =>
    (f.status === 'headless-documented' || f.status === 'orphan') &&
    f.priority &&
    f.priority.category !== 'api-only' &&
    f.priority.category !== 'complete'
  );

  const apiOnlyFeatures = features.filter(f =>
    f.priority && f.priority.category === 'api-only'
  );

  md += '## 1. Executive Summary\n\n';
  md += `- **Total Features:** ${c.features}\n`;
  md += `- **Complete Features:** ${c.features - c.orphanEndpoints}\n`; // This stat might be weird if orphanEndpoints is a count of endpoints, not features. Assuming c.orphanEndpoints is correct from scanner.
  md += `- **Truly Headless Features:** ${trulyHeadless.length}\n`;
  md += `- **API-Only Features:** ${apiOnlyFeatures.length}\n`;
  md += `- **Orphan Endpoints:** ${report.orphanEndpoints ? report.orphanEndpoints.length : 0}\n\n`;

  // High Priority Headless (Top 10, exclude API-only)
  md += '## 2. High-Priority Headless Features (Top 10)\n\n';
  md += '_Features that need UI development, excluding API-only endpoints_\n\n';

  const highPriority = trulyHeadless
    .sort((a, b) => b.priority.score - a.priority.score)
    .slice(0, 10);

  if (highPriority.length === 0) {
    md += '_No high-priority headless features found._\n\n';
  }

  highPriority.forEach(f => {
    // Correctly access endpoints from the new structure
    const endpoints = f.backend?.endpoints || [];

    md += `### ${f.key} (Score: ${f.priority.score}/100)\n\n`;
    md += `**Status:** ${f.status}\n`;
    md += `**Priority:** ${f.priority.level} (${f.priority.category})\n\n`;

    md += `**Endpoints (${endpoints.length}):**\n`;
    if (endpoints.length > 0) {
      endpoints.forEach(ep => md += `- ${ep.method} ${ep.path} (\`${path.basename(ep.sourceFile)}\`)\n`);
    } else {
      md += `- (No exact endpoint hits, matched via service/model files)\n`;
    }
    md += '\n';

    md += `**Score Breakdown:**\n`;
    const b = f.priority.breakdown;
    md += `- n8n Workflow Usage: ${b.n8n > 0 ? `✅ (+${b.n8n})` : b.n8n < 0 ? `❌ (${b.n8n}, API-only)` : '➖ (0)'}\n`;
    md += `- Endpoint Count: ${b.endpoints} pts\n`;
    md += `- Documentation: ${b.docs} pts\n`;
    md += `- Security/Admin: ${b.security} pts\n`;
    md += `- Recent Activity: ${b.activity} pts\n`;
    if (b.falsePositive) md += `- False Positive Penalty: ${b.falsePositive} pts\n`;
    if (b.ui) md += `- UI Detection Penalty: ${b.ui} pts\n`;
    md += '\n';

    // Why Build UI explanation
    if (f.priority.score >= 70) {
      md += `**Why Build UI:** Critical feature with ${endpoints.length} endpoints and strong documentation. High priority for user accessibility.\n\n`;
    } else if (f.priority.score >= 50) {
      md += `**Why Build UI:** High-value feature that would benefit from user-friendly interface for non-technical users.\n\n`;
    } else {
      md += `**Why Build UI:** Moderate priority. Consider if users frequently request this functionality.\n\n`;
    }

    md += `**Suggested UI location:** /public/${f.key.replace(/\s+/g, '-').toLowerCase()}.html\n\n`;
    md += `---\n\n`;
  });

  // API-Only Features
  md += '## 3. API-Only Features\n\n';
  md += '_Features designed for programmatic access only (n8n workflows, backend integrations)_\n\n';

  if (apiOnlyFeatures.length === 0) {
    md += '_No API-only features identified._\n\n';
  } else {
    apiOnlyFeatures.slice(0, 10).forEach(f => {
      const endpoints = f.backend?.endpoints || [];
      md += `### ${f.key}\n\n`;
      md += `**Endpoints (${endpoints.length}):**\n`;
      endpoints.forEach(ep => md += `- ${ep.method} ${ep.path}\n`);
      md += `\n**Why API-Only:** ${f.priority.breakdown.n8n < 0 ? 'n8n webhook endpoint' : 'Programmatic integration endpoint'}\n\n`;
    });
  }

  // Orphan Endpoints with Categorization
  md += '## 4. Orphan Endpoints Analysis\n\n';
  const orphans = report.orphanEndpoints || [];

  if (orphans.length === 0) {
    md += '_No orphan endpoints found._\n\n';
  } else {
    // Categorize orphans
    const falsePositives = [];
    const apiOnly = [];
    const needsReview = [];

    orphans.forEach(op => {
      const epKey = `${op.method} ${op.path}`;
      if (FALSE_POSITIVE_ENDPOINTS.includes(epKey)) {
        falsePositives.push({ ...op, status: '✅ In Use' });
      } else if (API_ONLY_ENDPOINTS.includes(epKey)) {
        apiOnly.push({ ...op, status: '🔧 API-Only' });
      } else {
        needsReview.push({ ...op, status: '⚠️ Verify' });
      }
    });

    md += '### False Positives (Scanner Missed Usage)\n\n';
    if (falsePositives.length === 0) {
      md += '_None_\n\n';
    } else {
      md += '| Status | Method | Path | Source File | Action |\n';
      md += '|--------|--------|------|-------------|--------|\n';
      falsePositives.forEach(op => {
        md += `| ${op.status} | ${op.method} | ${op.path} | \`${path.basename(op.sourceFile)}\` | Link to existing feature |\n`;
      });
      md += '\n';
    }

    md += '### API-Only Endpoints\n\n';
    if (apiOnly.length === 0) {
      md += '_None_\n\n';
    } else {
      md += '| Status | Method | Path | Source File | Action |\n';
      md += '|--------|--------|------|-------------|--------|\n';
      apiOnly.forEach(op => {
        md += `| ${op.status} | ${op.method} | ${op.path} | \`${path.basename(op.sourceFile)}\` | Document in API reference |\n`;
      });
      md += '\n';
    }

    md += '### Needs Review\n\n';
    if (needsReview.length === 0) {
      md += '_None - All orphans categorized!_\n\n';
    } else {
      md += '| Status | Method | Path | Source File | Action |\n';
      md += '|--------|--------|------|-------------|--------|\n';
      needsReview.forEach(op => {
        md += `| ${op.status} | ${op.method} | ${op.path} | \`${path.basename(op.sourceFile)}\` | Review code for actual usage |\n`;
      });
      md += '\n';
    }
  }

  fs.writeFileSync(outFile, md, 'utf8');
}

async function main() {
  const { root, out } = parseArgs(process.argv);

  console.log(`Scanning workspace at ${root}...`);
  const report = scanWorkspace({ rootDir: root });

  // Calculate Priorities
  console.log('Calculating priority scores...');
  report.features.forEach(f => {
    f.priority = calculatePriority(f, root);
  });

  const reportsDir = path.join(root, 'reports');
  ensureDir(reportsDir);

  const outPath = out
    ? path.resolve(root, out)
    : path.join(reportsDir, 'feature-alignment.json');

  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  // Generate Markdown Action Report
  const mdPath = path.join(reportsDir, 'feature-alignment-actions.md');
  generateMarkdownReport(report, mdPath, report.features);

  // Console summary
  const c = report.summary.counts;
  console.log(`Feature alignment scan complete:`);
  console.log(`- Features: ${c.features}`);
  console.log(`- Frontend HTML: ${c.frontendFiles}`);
  console.log(`- Backend endpoints: ${c.backendEndpoints}`);
  console.log(`- Docs MD: ${c.docsFiles}`);
  console.log(`- Orphan endpoints: ${c.orphanEndpoints}`);
  console.log(`Output JSON: ${path.relative(root, outPath)}`);
  console.log(`Output MD: ${path.relative(root, mdPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
