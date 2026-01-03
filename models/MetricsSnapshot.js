const mongoose = require('mongoose');

const METRIC_TYPES = ['health', 'performance', 'cost', 'resource', 'quality', 'usage'];
const retentionDays = parseInt(process.env.METRICS_RETENTION_DAYS || '90', 10);
const expireAfterSeconds = Number.isFinite(retentionDays) && retentionDays > 0
  ? retentionDays * 24 * 60 * 60
  : 90 * 24 * 60 * 60;

const MetricsSnapshotSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    required: true
  },
  type: {
    type: String,
    enum: METRIC_TYPES,
    required: true,
    index: true
  },
  componentId: {
    type: String,
    required: true,
    index: true
  },
  value: {
    type: Number,
    required: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

MetricsSnapshotSchema.index({ timestamp: 1 }, { expireAfterSeconds });
MetricsSnapshotSchema.index({ componentId: 1, timestamp: -1 });
MetricsSnapshotSchema.index({ type: 1, componentId: 1, timestamp: -1 });

MetricsSnapshotSchema.pre('validate', function ensureDate() {
  if (this.timestamp && !(this.timestamp instanceof Date)) {
    this.timestamp = new Date(this.timestamp);
  }
});

MetricsSnapshotSchema.statics.getLatest = async function(componentId, type = null) {
  if (!componentId) return null;

  const query = { componentId };
  if (type) query.type = type;

  return this.findOne(query).sort({ timestamp: -1 });
};

MetricsSnapshotSchema.statics.getSeries = async function(filter = {}, range = {}) {
  const query = {};

  if (filter.componentId) query.componentId = filter.componentId;
  if (filter.type) query.type = filter.type;
  if (filter.metadata && typeof filter.metadata === 'object') {
    Object.entries(filter.metadata).forEach(([key, value]) => {
      query[`metadata.${key}`] = value;
    });
  }

  if (range.from || range.to) {
    query.timestamp = {};
    if (range.from) query.timestamp.$gte = new Date(range.from);
    if (range.to) query.timestamp.$lte = new Date(range.to);
  }

  return this.find(query).sort({ timestamp: 1 }).lean();
};

module.exports = mongoose.model('MetricsSnapshot', MetricsSnapshotSchema);
