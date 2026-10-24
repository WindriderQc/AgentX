const mongoose = require('mongoose');

// A stored route names a model on a host, or a runtime topology role whose
// endpoint pin serves it (#360): host xor role, checked by the router config.
function hostRoute() {
  return !this.role;
}

const RouterTaskConfigSchema = new mongoose.Schema({
  taskType: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  model: {
    type: String,
    required: hostRoute,
    trim: true
  },
  host: {
    type: String,
    required: hostRoute,
    trim: true
  },
  role: {
    type: String,
    enum: ['conversation', 'background', 'pooled'],
    trim: true
  },
  group: {
    type: String,
    trim: true
  }
}, {
  timestamps: true,
  collection: 'routertaskconfigs'
});

module.exports = mongoose.model('RouterTaskConfig', RouterTaskConfigSchema);
