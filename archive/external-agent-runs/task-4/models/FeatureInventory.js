const mongoose = require('mongoose');

const FeatureInventorySchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  category: {
    type: String,
    enum: ['core', 'analytics', 'operations', 'experimental', 'deprecated'],
    required: true
  },
  status: {
    type: String,
    enum: ['complete', 'partial', 'planned', 'orphaned', 'deprecated'],
    required: true
  },

  frontend: {
    exists: { type: Boolean, default: false },
    pages: [String],          // ['analytics.html', 'dashboard.html']
    components: [String],      // ['analytics.js', 'cost-chart.js']
    lines: [Number],           // Line numbers where feature appears
    lastVerified: Date
  },

  backend: {
    exists: { type: Boolean, default: false },
    services: [String],        // ['costCalculator.js']
    models: [String],          // ['ModelPricingConfig.js']
    routes: [String],          // ['analytics.js']
    endpoints: [String],       // ['/api/analytics/costs']
    lastVerified: Date
  },

  documentation: {
    exists: { type: Boolean, default: false },
    files: [String],           // ['COST_TRACKING_SUMMARY.txt']
    completeness: { type: Number, min: 0, max: 100, default: 0 },
    lastVerified: Date
  },

  roadmap: {
    status: {
      type: String,
      enum: ['complete', 'in-progress', 'planned', 'backlog', 'not-tracked'],
      default: 'planned'
    },
    priority: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'medium'
    },
    lastUpdated: Date
  },

  metadata: {
    description: String,
    tags: [String],
    addedDate: { type: Date, default: Date.now },
    addedBy: String
  }
});

// Indexes
FeatureInventorySchema.index({ category: 1, status: 1 });
FeatureInventorySchema.index({ 'roadmap.status': 1 });

// Helper methods

/**
 * Returns an alignment report grouping features by status
 * Returns: { complete: [...], partial: [...], missing: [...] }
 */
FeatureInventorySchema.statics.getAlignmentReport = async function() {
  const features = await this.find({});
  const report = {
    complete: [],
    partial: [],
    missing: [],
    orphaned: [],
    deprecated: []
  };

  features.forEach(feature => {
    // Map internal status to report buckets if necessary, 
    // or just use the status field directly if it matches.
    // Spec status: ['complete', 'partial', 'planned', 'orphaned', 'deprecated']
    // Report keys match statuses mostly.
    
    if (report[feature.status]) {
      report[feature.status].push(feature);
    } else {
      // Fallback for 'planned' -> missing in the context of "Alignment" usually means implemented vs not.
      // But let's stick to the spec groupings: complete, partial, missing.
      // Detailed spec says: Returns: { complete: [...], partial: [...], missing: [...] }
      
      if (feature.status === 'planned') {
        report.missing.push(feature);
      } else {
        // If we have other statuses not explicitly mapped in the simple return object example
        // We'll put them in a generic bucket or handle them.
        // Let's assume 'orphaned' and 'deprecated' are also valuable to separate if possible,
        // but to strictly follow "Returns: { complete: [...], partial: [...], missing: [...] }",
        // we might group them. However, detailed alignment report usually wants to see everything.
        // I will return all statuses mapped to the closest logical bucket or keep them as keys if strictness allows.
        // Given the spec shows specific keys, let's group 'orphaned' into 'partial' or 'missing' or add keys.
        // I will add the keys to the result object to be safe and more useful.
        report[feature.status] = report[feature.status] || [];
        report[feature.status].push(feature);
      }
    }
  });

  return report;
};

/**
 * Returns: 0-100 based on frontend/backend/docs presence
 */
FeatureInventorySchema.methods.calculateAlignmentScore = function() {
  let score = 0;
  
  // Weights: Frontend 33.3%, Backend 33.3%, Documentation 33.3%
  if (this.frontend && this.frontend.exists) score += 33.33;
  if (this.backend && this.backend.exists) score += 33.33;
  if (this.documentation && this.documentation.exists) {
    // Adjust by completeness if available, otherwise full points
    const completeness = this.documentation.completeness || 100;
    score += (33.34 * (completeness / 100));
  }

  return Math.min(Math.round(score), 100);
};

module.exports = mongoose.model('FeatureInventory', FeatureInventorySchema);
