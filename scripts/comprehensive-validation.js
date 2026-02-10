#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { scanWorkspace } = require('../src/services/featureAlignmentScanner');
const { calculatePriority } = require('../src/services/featureAlignmentPriority');
const {
  analyzeServiceCoverage,
  analyzeModelCoverage,
  analyzeDocumentationCoverage,
  detectUnmountedRoutes
} = require('../src/services/validationScanner');

const ROOT = path.resolve(__dirname, '..');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function run() {
  console.log('=== Comprehensive Validation ===\n');
  const t0 = Date.now();

  // 1. Existing feature alignment scan
  console.log('[1/5] Running endpoint/feature alignment scan...');
  const featureReport = scanWorkspace({ rootDir: ROOT });
  featureReport.features.forEach(f => { f.priority = calculatePriority(f, ROOT); });

  // 2. Service coverage
  console.log('[2/5] Analyzing service coverage...');
  const serviceCoverage = analyzeServiceCoverage(ROOT);

  // 3. Model coverage
  console.log('[3/5] Analyzing model coverage...');
  const modelCoverage = analyzeModelCoverage(ROOT);

  // 4. Documentation coverage
  console.log('[4/5] Analyzing documentation coverage...');
  const docCoverage = analyzeDocumentationCoverage(ROOT);

  // 5. Unmounted routes
  console.log('[5/5] Detecting unmounted routes...');
  const routeHealth = detectUnmountedRoutes(ROOT);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ─── Consolidate ────────────────────────────────────────────
  const report = {
    generatedAt: new Date().toISOString(),
    elapsedSeconds: parseFloat(elapsed),
    endpointAlignment: featureReport.summary,
    serviceCoverage: serviceCoverage.summary,
    modelCoverage: modelCoverage.summary,
    documentationCoverage: docCoverage.summary,
    routeHealth: routeHealth.summary,
    details: {
      features: featureReport.features,
      orphanEndpoints: featureReport.orphanEndpoints,
      services: serviceCoverage.services,
      models: modelCoverage.models,
      brokenLinks: docCoverage.brokenLinks,
      orphanedDocs: docCoverage.orphanedDocs,
      undocumentedRoutes: docCoverage.undocumentedRoutes,
      unmountedRoutes: routeHealth.unmounted,
      subRouters: routeHealth.subRouters,
      duplicateMounts: routeHealth.duplicates,
      archivedRoutes: routeHealth.archived,
      inlineRoutes: routeHealth.inlineRoutes,
      mountedRoutes: routeHealth.mounted
    }
  };

  // ─── Write outputs ──────────────────────────────────────────
  const reportsDir = path.join(ROOT, 'reports');
  ensureDir(reportsDir);

  const jsonPath = path.join(reportsDir, 'comprehensive-validation.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const mdPath = path.join(reportsDir, 'comprehensive-validation-actions.md');
  fs.writeFileSync(mdPath, generateMarkdown(report), 'utf8');

  // ─── Console summary ───────────────────────────────────────
  console.log(`\nDone in ${elapsed}s\n`);
  printSummaryTable(report);
  console.log(`\nJSON  -> ${path.relative(ROOT, jsonPath)}`);
  console.log(`MD    -> ${path.relative(ROOT, mdPath)}`);
}

// ─── Markdown Report ──────────────────────────────────────────────

function generateMarkdown(report) {
  const d = report.details;
  let md = '# Comprehensive Validation Report\n\n';
  md += `Generated: ${report.generatedAt} (${report.elapsedSeconds}s)\n\n`;

  // Summary table
  md += '## Summary Dashboard\n\n';
  md += '| Category | Total | Covered | Gaps |\n';
  md += '|----------|-------|---------|------|\n';

  const ea = report.endpointAlignment;
  md += `| Endpoints | ${ea.counts.backendEndpoints} | ${ea.counts.backendEndpoints - ea.counts.orphanEndpoints} | ${ea.counts.orphanEndpoints} |\n`;

  const sc = report.serviceCoverage;
  md += `| Services | ${sc.total} | ${sc.fullyUsed + sc.partiallyUsed} | ${sc.orphan} |\n`;

  const mc = report.modelCoverage;
  md += `| Models | ${mc.total} | ${mc.routeFacing + mc.serviceOnly} | ${mc.orphan} |\n`;

  const dc = report.documentationCoverage;
  md += `| Docs (broken links) | ${dc.totalDocs} | ${dc.totalDocs - dc.brokenLinks} | ${dc.brokenLinks} |\n`;
  md += `| Docs (orphaned) | ${dc.totalDocs} | ${dc.totalDocs - dc.orphanedDocs} | ${dc.orphanedDocs} |\n`;

  const rh = report.routeHealth;
  md += `| Route Files | ${rh.totalRouteFiles} | ${rh.mounted} | ${rh.unmounted} |\n`;
  md += '\n';

  // ─── Gap Items ──────────────────────────────────────────────
  md += '## Gap Items\n\n';
  let gapNum = 0;

  // Unmounted routes
  for (const route of d.unmountedRoutes) {
    gapNum++;
    md += `### GAP-${String(gapNum).padStart(3, '0')}: ${route.file} not mounted [HIGH]\n`;
    md += `- **Type**: unmounted-route\n`;
    md += `- **Impact**: All endpoints in ${route.file} unreachable\n`;
    md += `- **Files**: ${route.file}, src/app.js\n`;
    md += `- **Fix**: Add require + app.use() mount to src/app.js\n`;
    md += `- **Effort**: trivial\n\n`;
  }

  // Duplicate mounts
  for (const dup of d.duplicateMounts) {
    gapNum++;
    md += `### GAP-${String(gapNum).padStart(3, '0')}: ${dup.routeFile} mounted ${dup.mountCount}x [MEDIUM]\n`;
    md += `- **Type**: duplicate-mount\n`;
    md += `- **Impact**: Route handlers registered multiple times (${dup.mounts.join(', ')})\n`;
    md += `- **Files**: ${dup.routeFile}, src/app.js\n`;
    md += `- **Fix**: Remove duplicate app.use() line\n`;
    md += `- **Effort**: trivial\n\n`;
  }

  // Orphan services (top 10)
  const orphanServices = d.services.filter(s => s.classification === 'orphan').slice(0, 10);
  for (const svc of orphanServices) {
    gapNum++;
    md += `### GAP-${String(gapNum).padStart(3, '0')}: ${svc.file} unused [LOW]\n`;
    md += `- **Type**: orphan-service\n`;
    md += `- **Impact**: Dead code; ${svc.exportedFunctions.length} exported functions unreferenced\n`;
    md += `- **Files**: ${svc.file}\n`;
    md += `- **Fix**: Remove or wire up; exported: ${svc.exportedFunctions.join(', ')}\n`;
    md += `- **Effort**: review\n\n`;
  }

  // Orphan models
  const orphanModels = d.models.filter(m => m.classification === 'orphan');
  for (const model of orphanModels) {
    gapNum++;
    md += `### GAP-${String(gapNum).padStart(3, '0')}: Model ${model.modelName} orphaned [LOW]\n`;
    md += `- **Type**: orphan-model\n`;
    md += `- **Impact**: Model in ${model.file} not required anywhere\n`;
    md += `- **Files**: ${model.file}\n`;
    md += `- **Fix**: Remove or integrate into a service/route\n`;
    md += `- **Effort**: review\n\n`;
  }

  // Broken doc links (top 20)
  const topBroken = d.brokenLinks.slice(0, 20);
  if (topBroken.length > 0) {
    gapNum++;
    md += `### GAP-${String(gapNum).padStart(3, '0')}: ${d.brokenLinks.length} broken documentation links [MEDIUM]\n`;
    md += `- **Type**: broken-doc-links\n`;
    md += `- **Impact**: Dead references in documentation\n`;
    md += '- **Examples**:\n';
    for (const link of topBroken) {
      md += `  - \`${link.sourceFile}\`: [${link.linkText}](${link.href}) -> ${link.resolvedPath}\n`;
    }
    if (d.brokenLinks.length > 20) {
      md += `  - ...and ${d.brokenLinks.length - 20} more\n`;
    }
    md += `- **Effort**: moderate\n\n`;
  }

  // Orphaned docs (top 15)
  if (d.orphanedDocs.length > 0) {
    gapNum++;
    md += `### GAP-${String(gapNum).padStart(3, '0')}: ${d.orphanedDocs.length} orphaned documentation files [LOW]\n`;
    md += `- **Type**: orphaned-docs\n`;
    md += `- **Impact**: Doc files not linked from any other doc\n`;
    md += '- **Files**:\n';
    for (const doc of d.orphanedDocs.slice(0, 15)) {
      md += `  - ${doc}\n`;
    }
    if (d.orphanedDocs.length > 15) {
      md += `  - ...and ${d.orphanedDocs.length - 15} more\n`;
    }
    md += `- **Fix**: Link from docs/INDEX.md or parent doc, or archive if stale\n`;
    md += `- **Effort**: moderate\n\n`;
  }

  // Undocumented routes (top 10)
  const topUndoc = d.undocumentedRoutes.slice(0, 10);
  if (topUndoc.length > 0) {
    gapNum++;
    md += `### GAP-${String(gapNum).padStart(3, '0')}: ${d.undocumentedRoutes.length} route files not mentioned in docs [LOW]\n`;
    md += `- **Type**: undocumented-routes\n`;
    md += `- **Impact**: No documentation coverage for these route modules\n`;
    md += '- **Files**:\n';
    for (const r of topUndoc) {
      md += `  - ${r}\n`;
    }
    if (d.undocumentedRoutes.length > 10) {
      md += `  - ...and ${d.undocumentedRoutes.length - 10} more\n`;
    }
    md += `- **Effort**: moderate\n\n`;
  }

  // Inline routes section
  if (d.inlineRoutes.length > 0) {
    md += '## Inline Routes (in src/app.js)\n\n';
    md += 'These routes are defined directly in app.js rather than in route modules:\n\n';
    md += '| Method | Path |\n';
    md += '|--------|------|\n';
    for (const r of d.inlineRoutes) {
      md += `| ${r.method} | ${r.path} |\n`;
    }
    md += '\n';
  }

  // Archived routes
  if (d.archivedRoutes.length > 0) {
    md += '## Archived Routes (commented out)\n\n';
    for (const r of d.archivedRoutes) {
      md += `- ${r}\n`;
    }
    md += '\n';
  }

  md += `---\n\nTotal gaps: ${gapNum}\n`;
  return md;
}

// ─── Console Table ────────────────────────────────────────────────

function printSummaryTable(report) {
  const ea = report.endpointAlignment;
  const sc = report.serviceCoverage;
  const mc = report.modelCoverage;
  const dc = report.documentationCoverage;
  const rh = report.routeHealth;

  const rows = [
    ['Endpoints', ea.counts.backendEndpoints, ea.counts.backendEndpoints - ea.counts.orphanEndpoints, ea.counts.orphanEndpoints],
    ['Services', sc.total, sc.fullyUsed + sc.partiallyUsed, sc.orphan],
    ['Models', mc.total, mc.routeFacing + mc.serviceOnly, mc.orphan],
    ['Docs (links)', dc.totalDocs, dc.totalDocs - dc.brokenLinks, dc.brokenLinks],
    ['Route Files', rh.totalRouteFiles, rh.mounted, rh.unmounted]
  ];

  console.log('Category       | Total | Covered | Gaps');
  console.log('---------------|-------|---------|-----');
  for (const [cat, total, covered, gaps] of rows) {
    console.log(`${cat.padEnd(15)}| ${String(total).padStart(5)} | ${String(covered).padStart(7)} | ${String(gaps).padStart(4)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────

try {
  run();
} catch (err) {
  console.error('Validation failed:', err);
  process.exit(1);
}
