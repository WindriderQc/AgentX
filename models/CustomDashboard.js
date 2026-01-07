/**
 * CustomDashboard Model
 *
 * Stores configuration for user-defined dashboards.
 * Scoped to Workspace.
 *
 * Week 4 Day 4 - Advanced Analytics
 */

const mongoose = require('mongoose');

const CustomDashboardSchema = new mongoose.Schema({
  // Workspace Context
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true
  },

  // Metadata
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },

  description: {
    type: String,
    maxlength: 500
  },

  // Configuration
  layout: [{
    id: { type: String, required: true }, // Widget ID
    x: { type: Number, required: true },  // Grid Column
    y: { type: Number, required: true },  // Grid Row
    w: { type: Number, required: true },  // Width (columns)
    h: { type: Number, required: true },  // Height (rows)
    
    // Widget Content
    type: { 
      type: String, 
      enum: ['metric', 'chart', 'table', 'markdown'],
      required: true 
    },
    
    title: String,
    
    // Data Configuration
    dataSource: {
      collection: { 
        type: String, 
        enum: ['conversations', 'prompts', 'feedbacks', 'models', 'alerts'],
        default: 'conversations'
      },
      aggregation: String, // 'count', 'avg', 'sum', 'min', 'max'
      field: String,       // Field to aggregate (e.g., 'messages.length')
      filter: Object,      // MongoDB query filters
      groupBy: String,     // Field to group by (for charts)
      pipeline: Array      // Custom aggregation pipeline for tables
    },
    
    // Visualization Options
    chartType: { 
      type: String, 
      enum: ['line', 'bar', 'pie', 'doughnut', 'area'],
    },
    
    color: String, // Hex color or theme name
    
    refreshInterval: {
      type: Number,
      default: 0 // 0 = no auto-refresh
    }
  }],

  // Access Control
  isPublic: {
    type: Boolean,
    default: false // false = private to creator, true = shared with workspace
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes
CustomDashboardSchema.index({ workspaceId: 1, createdBy: 1 });
CustomDashboardSchema.index({ workspaceId: 1, isPublic: 1 });

// Update timestamp on save
CustomDashboardSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('CustomDashboard', CustomDashboardSchema);
