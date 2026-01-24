const mongoose = require('mongoose');

const DocFileSchema = new mongoose.Schema({
  path: { type: String, required: true },
  category: { type: String, enum: ['PERMANENT', 'TRANSIENT', 'UNKNOWN'], required: true },
  reason: { type: String, default: '' },
  referencedByIndex: { type: Boolean, default: false },
  size: { type: Number, default: 0 },
  mtime: { type: Date, required: false }
}, { _id: false });

const ObservationSchema = new mongoose.Schema({
  severity: { type: String, enum: ['info', 'warn', 'fail'], required: true },
  type: { type: String, required: true },
  message: { type: String, required: true },
  path: { type: String, required: false },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const RecommendationSchema = new mongoose.Schema({
  severity: { type: String, enum: ['info', 'warn', 'fail'], required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  actions: { type: [String], default: [] },
  relatedPaths: { type: [String], default: [] }
}, { _id: false });

const DocJanitorScanSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false,
    index: true
  },
  repoPath: { type: String, required: true, index: true },
  status: { type: String, enum: ['ok', 'warn', 'fail'], required: true, default: 'ok' },
  scanDuration: { type: Number, required: false },

  summary: {
    totalMdFiles: { type: Number, default: 0 },
    permanent: { type: Number, default: 0 },
    transient: { type: Number, default: 0 },
    unknown: { type: Number, default: 0 },
    indexLinks: { type: Number, default: 0 },
    brokenIndexLinks: { type: Number, default: 0 }
  },

  files: { type: [DocFileSchema], default: [] },
  observations: { type: [ObservationSchema], default: [] },
  recommendations: { type: [RecommendationSchema], default: [] },

  scannedAt: { type: Date, default: Date.now, index: true },
  createdAt: { type: Date, default: Date.now }
});

DocJanitorScanSchema.index({ repoPath: 1, scannedAt: -1 });
DocJanitorScanSchema.index({ workspaceId: 1, scannedAt: -1 });
DocJanitorScanSchema.index({ status: 1, scannedAt: -1 });

DocJanitorScanSchema.statics.getLatest = async function(repoPath, workspaceId = null) {
  const query = { repoPath };
  if (workspaceId) query.workspaceId = workspaceId;
  return this.findOne(query).sort({ scannedAt: -1 });
};

module.exports = mongoose.model('DocJanitorScan', DocJanitorScanSchema);

