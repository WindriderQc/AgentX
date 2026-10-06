#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');

const DEFAULT_BASE_URL = 'http://127.0.0.1:3083/api/v1';
const DEFAULT_ROOT = '/mnt/datalake';
const DEFAULT_PROFILE_NAME = 'Shared Drives Janitor - Datalake assessment';
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), '.agentx/reports/datalake-maintenance');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    baseUrl: process.env.AGENTX_DATA_BASE_URL || DEFAULT_BASE_URL,
    root: process.env.DATALAKE_MAINTENANCE_ROOT || DEFAULT_ROOT,
    outputDir: process.env.DATALAKE_MAINTENANCE_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    profileName: process.env.DATALAKE_MAINTENANCE_PROFILE || DEFAULT_PROFILE_NAME,
    profileRunId: process.env.DATALAKE_MAINTENANCE_RUN_ID || null,
    ensureProfile: true,
    runProfile: false,
    computeHashes: false,
    hashMode: 'candidates',
    hashMaxFiles: 5000,
    hashMaxBytes: 50 * 1024 * 1024 * 1024,
    aiTriage: false,
    liveSample: false,
    treeLimit: 10,
    sampleLimit: 20,
    duplicateLimit: 20,
    timeoutMs: 120000,
    runTimeoutMs: 30 * 60 * 1000,
    pollIntervalMs: 2000
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--base-url') opts.baseUrl = next();
    else if (arg === '--root') opts.root = next();
    else if (arg === '--output-dir') opts.outputDir = next();
    else if (arg === '--profile-name') opts.profileName = next();
    else if (arg === '--profile-run-id') opts.profileRunId = next();
    else if (arg === '--run-profile') opts.runProfile = true;
    else if (arg === '--no-profile') opts.ensureProfile = false;
    else if (arg === '--no-hashes') { opts.computeHashes = false; opts.hashMode = 'none'; }
    else if (arg === '--hash-mode') opts.hashMode = next();
    else if (arg === '--hash-max-files') opts.hashMaxFiles = Number(next());
    else if (arg === '--hash-max-bytes') opts.hashMaxBytes = Number(next());
    else if (arg === '--ai-triage') opts.aiTriage = true;
    else if (arg === '--live-sample') opts.liveSample = true;
    else if (arg === '--tree-limit') opts.treeLimit = Number(next());
    else if (arg === '--sample-limit') opts.sampleLimit = Number(next());
    else if (arg === '--duplicate-limit') opts.duplicateLimit = Number(next());
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(next());
    else if (arg === '--run-timeout-ms') opts.runTimeoutMs = Number(next());
    else if (arg === '--poll-interval-ms') opts.pollIntervalMs = Number(next());
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!['none', 'candidates', 'all'].includes(opts.hashMode)) {
    throw new Error('--hash-mode must be one of: none, candidates, all');
  }
  return opts;
}

function usage() {
  return [
    'Usage: node data/scripts/datalake-maintenance-workflow.js [options]',
    '',
    'Creates a supervised, proposal-only datalake maintenance report from Data APIs.',
    '',
    'Options:',
    `  --base-url <url>       Data API base URL (default: ${DEFAULT_BASE_URL})`,
    `  --root <path>          Bounded datalake root (default: ${DEFAULT_ROOT})`,
    '  --output-dir <path>    Report output directory (default: .agentx/reports/...)',
    '  --profile-name <name>  Janitor profile name to ensure/update',
    '  --profile-run-id <id>  Include an existing profile run without starting one',
    '  --run-profile         Run the ensured profile and include pending actions',
    '  --no-profile          Do not create/update the safe default profile',
    '  --no-hashes           Legacy alias: do not run full-file hashing',
    '  --hash-mode <mode>    none, candidates (default), or all',
    '  --hash-max-files <n>  Candidate hash file budget per profile run',
    '  --hash-max-bytes <n>  Candidate hash byte budget per profile run',
    '  --ai-triage           Enable profile AI triage (off by default)',
    '  --live-sample         Run the capped live janitor sample (off by default)',
    '  --tree-limit <n>      Directory sample limit',
    '  --sample-limit <n>    Largest-file sample limit',
    '  --duplicate-limit <n> Duplicate group sample limit'
  ].join('\n');
}

function endpoint(baseUrl, route) {
  return `${String(baseUrl).replace(/\/+$/, '')}${route}`;
}

async function requestJson(baseUrl, route, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 120000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint(baseUrl, route), {
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = json.message || json.error || `HTTP ${res.status}`;
      throw new Error(`${route}: ${msg}`);
    }
    return json.data !== undefined ? json.data : json;
  } finally {
    clearTimeout(timer);
  }
}

async function collect(name, fn) {
  try {
    return { name, ok: true, data: await fn() };
  } catch (err) {
    return { name, ok: false, error: err.message };
  }
}

function profilePayload(options) {
  return {
    name: options.profileName,
    roots: [options.root],
    extensions: { include: [], exclude: [] },
    computeHashes: options.hashMode === 'all' || options.computeHashes === true,
    hashMode: options.hashMode,
    hashBudget: {
      maxFiles: options.hashMaxFiles,
      maxBytes: options.hashMaxBytes
    },
    policies: ['delete_duplicates'],
    schedule: null,
    aiTriage: options.aiTriage === true
  };
}

function profileId(profile) {
  return profile?._id?.$oid || profile?._id || profile?.id || null;
}

async function ensureProfile(baseUrl, options, req) {
  const payload = profilePayload(options);
  const listed = await req(baseUrl, '/janitor/profiles', { timeoutMs: options.timeoutMs });
  const profiles = listed.profiles || [];
  const existing = profiles.find(p => p.name === options.profileName);
  if (existing) {
    const id = profileId(existing);
    const updated = await req(baseUrl, `/janitor/profiles/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: payload,
      timeoutMs: options.timeoutMs
    });
    return { action: 'updated', profile: updated.profile, id };
  }

  const created = await req(baseUrl, '/janitor/profiles', {
    method: 'POST',
    body: payload,
    timeoutMs: options.timeoutMs
  });
  return { action: 'created', profile: created.profile, id: profileId(created.profile) };
}

async function runProfile(baseUrl, profile, options, req) {
  const id = profile.id || profileId(profile.profile);
  if (!id) throw new Error('cannot run profile without id');
  const result = await req(baseUrl, `/janitor/profiles/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    timeoutMs: options.timeoutMs
  });
  const runId = result.run_id;
  const deadline = Date.now() + options.runTimeoutMs;
  while (Date.now() < deadline) {
    const detail = await req(baseUrl, `/janitor/profiles/runs/${encodeURIComponent(runId)}`, {
      timeoutMs: options.timeoutMs
    });
    if (['complete', 'failed', 'stopped'].includes(detail.run?.status)) {
      return { run_id: runId, run: detail.run };
    }
    await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs));
  }
  throw new Error(`profile run ${runId} did not finish within ${options.runTimeoutMs}ms`);
}

async function getProfileRun(baseUrl, runId, options, req) {
  const detail = await req(baseUrl, `/janitor/profiles/runs/${encodeURIComponent(runId)}`, {
    timeoutMs: options.timeoutMs
  });
  return { run_id: runId, run: detail.run };
}

function unwrap(result, fallback = null) {
  return result && result.ok ? result.data : fallback;
}

function makeProposalList(collected, profileRun) {
  const proposals = [];
  const cleanup = unwrap(collected.cleanupRecommendations, {});
  for (const rec of cleanup.recommendations || []) {
    proposals.push({
      source: 'storage.cleanup-recommendations',
      type: rec.type,
      priority: rec.priority || 'review',
      evidence: rec.message,
      evidenceType: rec.evidence || 'review-signal',
      reviewBytes: rec.reviewBytes || null,
      potentialSavings: rec.potentialSavings || null,
      sampleFiles: Array.isArray(rec.files) ? rec.files.slice(0, 5).map(file => file.path || file) : [],
      approvalStatus: 'proposal_only'
    });
  }

  const suggest = unwrap(collected.janitorSuggest, {});
  for (const item of suggest.suggestions || []) {
    proposals.push({
      source: 'janitor.suggest',
      type: item.policy || 'suggestion',
      priority: 'review',
      evidence: item.reason,
      fileCount: Array.isArray(item.files) ? item.files.length : 0,
      sampleFiles: Array.isArray(item.files) ? item.files.slice(0, 5) : [],
      potentialSavings: item.space_saved || 0,
      approvalStatus: 'not_approved'
    });
  }

  const actions = profileRun?.run?.proposed_actions || [];
  actions.forEach((action, idx) => {
    proposals.push({
      source: 'janitor.profile-run',
      type: action.policy,
      priority: 'review',
      evidence: action.reason,
      fileCount: Array.isArray(action.files) ? action.files.length : 0,
      sampleFiles: Array.isArray(action.files) ? action.files.slice(0, 5) : [],
      potentialSavings: action.space_saved || 0,
      approvalStatus: action.status || 'pending',
      approvalEndpoint: `POST /api/v1/janitor/profiles/runs/${profileRun.run_id}/actions/${idx}/approve`
    });
  });

  return proposals
    .sort((a, b) => (b.potentialSavings || 0) - (a.potentialSavings || 0))
    .map((p, idx) => ({ rank: idx + 1, ...p }));
}

function buildReport({ options, generatedAt, collected, profile, profileRun }) {
  const proposals = makeProposalList(collected, profileRun);
  const summary = unwrap(collected.storageSummary, {});
  const files = unwrap(collected.largestFiles, {});
  const tree = unwrap(collected.directoryTree, {});
  const duplicates = unwrap(collected.duplicates, {});
  const stats = unwrap(collected.fileStats, {});
  const suggest = unwrap(collected.janitorSuggest, {});

  return {
    metadata: {
      generatedAt,
      workflow: 'datalake-maintenance',
      mode: 'supervised-dry-run',
      baseUrl: options.baseUrl,
      root: options.root,
      outputDir: options.outputDir
    },
    safety: {
      destructiveRequestsMade: 0,
      deleteMoveArchiveExecuted: false,
      approvalRequiredForDestructiveActions: true,
      approvalEndpointsCalled: false,
      scheduleEnabled: false,
      boundary: 'Data APIs provide evidence; LeadX/OpenClaw may reason over reports; humans approve destructive actions.'
    },
    profile: profile || profileRun ? {
      action: profile?.action || 'existing_run',
      id: profile?.id || profileRun?.run?.profile_id || null,
      name: profileRun?.run?.profile_name || options.profileName,
      roots: [options.root],
      computeHashes: options.hashMode === 'all' || options.computeHashes === true,
      hashMode: options.hashMode,
      hashBudget: { maxFiles: options.hashMaxFiles, maxBytes: options.hashMaxBytes },
      policies: ['delete_duplicates'],
      schedule: null,
      run: profileRun ? {
        run_id: profileRun.run_id,
        status: profileRun.run?.status,
        proposedActionCount: profileRun.run?.proposed_actions?.length || 0,
        aiTriage: profileRun.run?.ai_triage || null
      } : null
    } : null,
    storage: {
      totalFiles: summary.totalFiles || 0,
      totalSize: summary.totalSize || 0,
      totalSizeFormatted: summary.totalSizeFormatted || null,
      lastScan: summary.lastScan || null,
      largestFiles: files.files || [],
      topDirectories: tree.tree || [],
      duplicateSummary: duplicates.summary || null,
      duplicateMethod: duplicates.method || null,
      duplicateVerified: duplicates.verified === true,
      duplicateCandidates: summary.duplicateCandidates || null,
      hashCoverage: {
        files: summary.hashCoverageFiles || duplicates.coverage?.fileRatio || 0,
        bytes: summary.hashCoverageBytes || duplicates.coverage?.byteRatio || 0,
        hashedFiles: summary.hashedFiles || duplicates.coverage?.hashedFiles || 0,
        hashedBytes: summary.hashedBytes || duplicates.coverage?.hashedBytes || 0
      }
    },
    organization: {
      categories: stats.byCategory || [],
      topExtensions: stats.byExtension || [],
      metadata: stats.total ? {
        missingExtension: stats.total.missingExtension || 0,
        invalidTimestamp: stats.total.invalidTimestamp || 0,
        categorizedFiles: summary.categorizedFiles || 0,
        coverage: summary.metadataCoverageFiles || 0
      } : null
    },
    janitorSuggest: {
      ok: collected.janitorSuggest.ok,
      suggestionsCount: suggest.suggestions_count || 0,
      totalSpaceSaved: suggest.total_space_saved || 0,
      policiesApplied: suggest.policies_applied || []
    },
    proposals,
    riskNotes: [
      'This report stores metadata only; it does not read or quote file contents.',
      'Only current SHA256 hashes are exact duplicate evidence; same-name or same-size matches remain candidates.',
      'Large and old files are review signals, not automatically reclaimable space.',
      options.liveSample
        ? 'The live filesystem sample is capped and must be treated as partial evidence.'
        : 'The capped live filesystem sample was intentionally skipped; this report uses indexed evidence.',
      'Approval links are informational. The workflow does not call approve, execute, delete, move, archive, chmod, or rename endpoints.',
      'Scheduling remains disabled until one supervised real run is accepted.'
    ],
    sourceStatus: Object.fromEntries(Object.entries(collected).map(([k, v]) => [k, v.ok ? 'ok' : `error: ${v.error}`]))
  };
}

function markdownReport(report) {
  const lines = [];
  lines.push(`# Datalake Maintenance Dry Run`);
  lines.push('');
  lines.push(`Generated: ${report.metadata.generatedAt}`);
  lines.push(`Root: \`${report.metadata.root}\``);
  lines.push(`Mode: ${report.metadata.mode}`);
  lines.push('');
  lines.push('## Safety');
  lines.push('');
  lines.push(`- Destructive requests made: ${report.safety.destructiveRequestsMade}`);
  lines.push(`- Delete/move/archive executed: ${report.safety.deleteMoveArchiveExecuted}`);
  lines.push(`- Approval endpoints called: ${report.safety.approvalEndpointsCalled}`);
  lines.push('- Legacy direct mutation routes available: false');
  lines.push(`- Schedule enabled: ${report.safety.scheduleEnabled}`);
  lines.push('');
  lines.push('## Storage Summary');
  lines.push('');
  lines.push(`- Files indexed: ${report.storage.totalFiles}`);
  lines.push(`- Indexed size: ${report.storage.totalSizeFormatted || report.storage.totalSize}`);
  lines.push(`- Last scan: ${report.storage.lastScan?.id || 'none'} (${report.storage.lastScan?.status || 'unknown'})`);
  lines.push(`- Current SHA256 coverage: ${(report.storage.hashCoverage.files * 100).toFixed(2)}% of files / ${(report.storage.hashCoverage.bytes * 100).toFixed(2)}% of bytes`);
  lines.push(`- Duplicate evidence: ${report.storage.duplicateVerified ? 'verified SHA256' : 'unverified candidates'} (${report.storage.duplicateMethod || 'none'})`);
  lines.push('');
  lines.push('## Top Directories');
  lines.push('');
  for (const dir of report.storage.topDirectories.slice(0, 10)) {
    lines.push(`- \`${dir.path}\`: ${dir.fileCount} files, ${dir.totalSizeFormatted || dir.totalSize}`);
  }
  lines.push('');
  lines.push('## Ranked Proposals');
  lines.push('');
  lines.push(`Showing ${Math.min(25, report.proposals.length)} of ${report.proposals.length} proposals by potential savings. The JSON report retains the complete received proposal list.`);
  const triage = report.profile?.run?.aiTriage;
  const coverage = triage?.coverage;
  if (coverage) lines.push(`AI triage ${triage.outcome || 'unknown'}: ${coverage.actions.included}/${coverage.actions.available} actions and ${coverage.fileEntries.included}/${coverage.fileEntries.available} file entries submitted. ${coverage.selection}`);
  if (report.proposals.length === 0) {
    lines.push('No proposal actions were generated for this bounded run.');
  } else {
    for (const p of report.proposals.slice(0, 25)) {
      lines.push(`${p.rank}. ${p.type} (${p.source})`);
      lines.push(`   - Status: ${p.approvalStatus}`);
      lines.push(`   - Evidence: ${p.evidence || 'n/a'}`);
      if (p.potentialSavings) lines.push(`   - Potential savings: ${p.potentialSavings} bytes`);
      if (p.reviewBytes) lines.push(`   - Bytes represented for review: ${p.reviewBytes} (not savings)`);
      if (p.approvalEndpoint) lines.push(`   - Approval endpoint: \`${p.approvalEndpoint}\``);
      if (p.sampleFiles?.length) lines.push(`   - Sample files: ${p.sampleFiles.map(f => `\`${f}\``).join(', ')}`);
    }
  }
  lines.push('');
  lines.push('## Source Status');
  lines.push('');
  for (const [name, status] of Object.entries(report.sourceStatus)) {
    lines.push(`- ${name}: ${status}`);
  }
  lines.push('');
  lines.push('## Risk Notes');
  lines.push('');
  for (const note of report.riskNotes) lines.push(`- ${note}`);
  lines.push('');
  return lines.join('\n');
}

async function writeReports(report, deps) {
  await deps.mkdir(report.metadata.outputDir, { recursive: true });
  const stamp = report.metadata.generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(report.metadata.outputDir, `datalake-maintenance-${stamp}.json`);
  const mdPath = path.join(report.metadata.outputDir, `datalake-maintenance-${stamp}.md`);
  await deps.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await deps.writeFile(mdPath, markdownReport(report));
  return { jsonPath, mdPath };
}

async function runWorkflow(options, deps = {}) {
  const req = deps.requestJson || requestJson;
  const now = deps.now || (() => new Date().toISOString());
  const io = {
    mkdir: deps.mkdir || fs.mkdir,
    writeFile: deps.writeFile || fs.writeFile
  };
  const generatedAt = now();

  let profile = null;
  let profileRun = null;
  if (options.ensureProfile) {
    profile = await ensureProfile(options.baseUrl, options, req);
    if (options.runProfile && !options.profileRunId) {
      profileRun = await runProfile(options.baseUrl, profile, options, req);
    }
  }
  if (options.profileRunId) {
    profileRun = await getProfileRun(options.baseUrl, options.profileRunId, options, req);
  }

  const collected = {
    storageSummary: await collect('storageSummary', () => req(options.baseUrl, `/storage/summary?root=${encodeURIComponent(options.root)}`, { timeoutMs: options.timeoutMs })),
    directoryTree: await collect('directoryTree', () => req(options.baseUrl, `/storage/files/tree?root=${encodeURIComponent(options.root)}&limit=${options.treeLimit}`, { timeoutMs: options.timeoutMs })),
    largestFiles: await collect('largestFiles', () => req(options.baseUrl, `/storage/files/browse?dirname=${encodeURIComponent(options.root)}&limit=${options.sampleLimit}&sortBy=size&sortOrder=desc`, { timeoutMs: options.timeoutMs })),
    fileStats: await collect('fileStats', () => req(options.baseUrl, `/storage/files/stats?root=${encodeURIComponent(options.root)}`, { timeoutMs: options.timeoutMs })),
    duplicates: await collect('duplicates', () => req(options.baseUrl, `/storage/files/duplicates?root=${encodeURIComponent(options.root)}&limit=${options.duplicateLimit}&method=auto`, { timeoutMs: options.timeoutMs })),
    cleanupRecommendations: await collect('cleanupRecommendations', () => req(options.baseUrl, `/storage/files/cleanup-recommendations?root=${encodeURIComponent(options.root)}`, { timeoutMs: options.timeoutMs })),
    policies: await collect('policies', () => req(options.baseUrl, '/janitor/policies', { timeoutMs: options.timeoutMs })),
    janitorSuggest: options.liveSample
      ? await collect('janitorSuggest', () => req(options.baseUrl, '/janitor/suggest', {
        method: 'POST',
        body: { path: options.root, policies: ['delete_duplicates', 'remove_temp_files', 'remove_large_files'] },
        timeoutMs: options.timeoutMs
      }))
      : { name: 'janitorSuggest', ok: true, data: { skipped: true, reason: 'live sample disabled' } }
  };

  const report = buildReport({ options, generatedAt, collected, profile, profileRun });
  const paths = await writeReports(report, io);
  return { report, paths };
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await runWorkflow(options);
  console.log(JSON.stringify({
    status: 'success',
    root: options.root,
    report: result.paths,
    proposals: result.report.proposals.length,
    destructiveRequestsMade: result.report.safety.destructiveRequestsMade,
    profileRun: result.report.profile?.run || null
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_ROOT,
  DEFAULT_PROFILE_NAME,
  parseArgs,
  requestJson,
  buildReport,
  markdownReport,
  runWorkflow
};
