const mongoose = require('mongoose');

const FindingSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'missing_test',
      'doc_duplication',
      'code_duplication',
      'architecture_violation',
      'missing_docs',
      'stale_docs',
      'structural_drift',
      'code_quality'
    ],
    required: true
  },
  severity: {
    type: String,
    enum: ['info', 'warn', 'fail'],
    required: true
  },
  path: {
    type: String,
    required: false
  },
  evidence: {
    type: String,
    required: true
  },
  confidence: {
    type: Number,
    min: 0,
    max: 1,
    default: 0.8
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { _id: false });

const RepoScanSchema = new mongoose.Schema({
  // Multi-tenancy support
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false,
    index: true
  },

  // Scan metadata
  repoPath: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['ok', 'warn', 'fail'],
    required: true
  },
  scanDuration: {
    type: Number, // milliseconds
    required: false
  },

  // Summary statistics
  summary: {
    totalFiles: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    infos: { type: Number, default: 0 },
    testCoverage: { type: Number, default: 0 }, // percentage
    duplicationRate: { type: Number, default: 0 }, // percentage
    docCoverage: { type: Number, default: 0 } // percentage
  },

  // Detailed findings
  findings: [FindingSchema],

  // File snapshot metadata
  snapshot: {
    fileCount: { type: Number, default: 0 },
    totalSize: { type: Number, default: 0 }, // bytes
    fileTypes: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    directories: {
      type: [String],
      default: []
    }
  },

  // Timestamps
  scannedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for efficient queries
RepoScanSchema.index({ repoPath: 1, scannedAt: -1 });
RepoScanSchema.index({ workspaceId: 1, scannedAt: -1 });
RepoScanSchema.index({ status: 1, scannedAt: -1 });

// Static method to get latest scan
RepoScanSchema.statics.getLatest = async function(repoPath, workspaceId = null) {
  const query = { repoPath };
  if (workspaceId) {
    query.workspaceId = workspaceId;
  }
  return this.findOne(query).sort({ scannedAt: -1 });
};

// Static method to get trend data
RepoScanSchema.statics.getTrends = async function(repoPath, workspaceId = null, limit = 10) {
  const query = { repoPath };
  if (workspaceId) {
    query.workspaceId = workspaceId;
  }

  const scans = await this.find(query)
    .sort({ scannedAt: -1 })
    .limit(limit)
    .select('scannedAt summary findings')
    .lean();

  // Process into trend data
  const timestamps = scans.map(s => s.scannedAt).reverse();
  const duplication = scans.map(s =>
    s.findings.filter(f => f.type.includes('duplication')).length
  ).reverse();
  const tests = scans.map(s =>
    s.findings.filter(f => f.type === 'missing_test').length
  ).reverse();
  const docs = scans.map(s =>
    s.findings.filter(f => f.type.includes('docs')).length
  ).reverse();

  return {
    timestamps: timestamps.map(t => new Date(t).toLocaleDateString()),
    duplication,
    tests,
    docs
  };
};

// Calculate status based on findings
RepoScanSchema.methods.calculateStatus = function() {
  const failCount = this.findings.filter(f => f.severity === 'fail').length;
  const warnCount = this.findings.filter(f => f.severity === 'warn').length;

  if (failCount > 0) {
    this.status = 'fail';
  } else if (warnCount > 0) {
    this.status = 'warn';
  } else {
    this.status = 'ok';
  }

  // Update summary counts
  this.summary.failures = failCount;
  this.summary.warnings = warnCount;
  this.summary.infos = this.findings.filter(f => f.severity === 'info').length;
};

module.exports = mongoose.model('RepoScan', RepoScanSchema);
