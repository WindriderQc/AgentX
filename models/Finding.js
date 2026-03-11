const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Finding — top-level normalized maintenance finding with full lifecycle.
 * Populated by maintenanceSnapshotService via scanner adapters.
 * Deduplicated by fingerprint (repo + scanner + category + evidenceKey).
 */
const FindingSchema = new mongoose.Schema({
  // Identity
  repo: { type: String, required: true },           // 'agentx' | 'dataapi'
  repoPath: { type: String, required: true },
  scanner: {
    type: String,
    enum: ['repo-watcher', 'doc-janitor', 'feature-alignment', 'validation-scanner'],
    required: true
  },
  fingerprint: { type: String, required: true, unique: true }, // dedup key

  // Classification
  category: {
    type: String,
    enum: [
      'missing_test', 'code_duplication', 'architecture_violation', 'code_quality',
      'doc_duplication', 'stale_docs', 'broken_link', 'missing_docs',
      'orphan_endpoint', 'undocumented_endpoint', 'unused_service',
      'unmounted_route', 'structural_drift', 'unknown'
    ],
    default: 'unknown'
  },
  severity: {
    type: String,
    enum: ['critical', 'high', 'medium', 'low', 'info'],
    default: 'info',
    index: true
  },
  confidence: { type: Number, min: 0, max: 1, default: 0.8 },

  // Content
  title: { type: String, required: true },
  description: { type: String, default: '' },
  evidence: { type: mongoose.Schema.Types.Mixed, default: {} }, // path(s), lines, snippets
  evidenceKey: { type: String, default: '' },                   // concise dedup key (source of fingerprint)
  suggestedAction: { type: String, default: '' },

  // Lifecycle
  status: {
    type: String,
    enum: ['new', 'acknowledged', 'deferred', 'resolved', 'false_positive'],
    default: 'new',
    index: true
  },
  statusChangedAt: { type: Date, default: null },
  statusChangedBy: { type: String, default: null },

  // Trend tracking
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  occurrenceCount: { type: Number, default: 1 }
}, {
  timestamps: true,
  collection: 'findings'
});

// Query indexes
FindingSchema.index({ repo: 1, status: 1, severity: 1 });
FindingSchema.index({ repo: 1, scanner: 1, status: 1 });
FindingSchema.index({ scanner: 1, createdAt: -1 });
FindingSchema.index({ status: 1, lastSeenAt: -1 });

/**
 * Generate a stable fingerprint for deduplication.
 * @param {string} repo
 * @param {string} scanner
 * @param {string} category
 * @param {string} evidenceKey — a concise string that identifies this specific finding
 */
FindingSchema.statics.makeFingerprint = function(repo, scanner, category, evidenceKey) {
  return crypto
    .createHash('sha256')
    .update(`${repo}::${scanner}::${category}::${evidenceKey}`)
    .digest('hex')
    .substring(0, 32);
};

/**
 * Upsert a finding — create or update lastSeenAt + occurrenceCount if already exists.
 * Only updates status if the finding is new (never overwrite acknowledged/deferred/resolved).
 */
FindingSchema.statics.upsertFinding = async function(data) {
  const fingerprint = this.makeFingerprint(data.repo, data.scanner, data.category, data.evidenceKey);

  const existing = await this.findOne({ fingerprint });
  if (existing) {
    existing.lastSeenAt = new Date();
    existing.occurrenceCount += 1;
    // Refresh content fields in case scanner improved the description
    existing.title = data.title || existing.title;
    existing.description = data.description || existing.description;
    existing.confidence = data.confidence ?? existing.confidence;
    existing.evidence = data.evidence || existing.evidence;
    existing.suggestedAction = data.suggestedAction || existing.suggestedAction;
    await existing.save();
    return { finding: existing, isNew: false };
  }

  const finding = await this.create({
    ...data,
    fingerprint,
    firstSeenAt: new Date(),
    lastSeenAt: new Date()
  });
  return { finding, isNew: true };
};

const Finding = mongoose.model('Finding', FindingSchema);
module.exports = Finding;
