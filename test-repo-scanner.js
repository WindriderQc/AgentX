/**
 * Quick test script for repo scanner improvements
 * Run: node test-repo-scanner.js
 */

const mongoose = require('mongoose');
const { getRepoWatcherService } = require('./src/services/repoWatcherService');

async function testScanner() {
  console.log('Testing repo scanner improvements...\n');

  try {
    // Connect to MongoDB (required for save operation)
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/agentx';
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB\n');

    // Run scan
    const service = getRepoWatcherService();
    const repoPath = process.cwd();

    console.log(`Scanning repository: ${repoPath}\n`);
    const startTime = Date.now();

    const result = await service.scan(repoPath, null);

    console.log(`\n✓ Scan completed in ${result.scanDuration}ms\n`);
    console.log('=== SUMMARY ===');
    console.log(`Status: ${result.status}`);
    console.log(`Total Files: ${result.summary.totalFiles}`);
    console.log(`Failures: ${result.summary.failures}`);
    console.log(`Warnings: ${result.summary.warnings}`);
    console.log(`Infos: ${result.summary.infos}`);
    console.log(`Test Coverage: ${result.summary.testCoverage}%`);
    console.log(`Duplication Rate: ${result.summary.duplicationRate}%`);
    console.log(`Doc Coverage: ${result.summary.docCoverage}%`);

    // Group findings by type
    const grouped = result.findings.reduce((acc, f) => {
      acc[f.type] = (acc[f.type] || 0) + 1;
      return acc;
    }, {});

    console.log('\n=== FINDINGS BY TYPE ===');
    Object.entries(grouped).forEach(([type, count]) => {
      console.log(`${type}: ${count}`);
    });

    // Show sample findings
    console.log('\n=== SAMPLE FINDINGS (first 5) ===');
    result.findings.slice(0, 5).forEach((f, i) => {
      console.log(`\n${i + 1}. [${f.severity.toUpperCase()}] ${f.type}`);
      console.log(`   Path: ${f.path || 'N/A'}`);
      console.log(`   Evidence: ${f.evidence}`);
      console.log(`   Confidence: ${Math.round(f.confidence * 100)}%`);
    });

    console.log(`\n\n✓ Total findings: ${result.findings.length} (vs 2,427 before fixes)`);

  } catch (error) {
    console.error('\n✗ Error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n✓ Disconnected from MongoDB');
  }
}

testScanner();
