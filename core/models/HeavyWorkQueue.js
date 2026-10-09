'use strict';

const mongoose = require('mongoose');

// Planning transitions share one Mongo CAS, including multi-resource bookings.
// This is neither a runtime admission nor a lease on a GPU.
const schema = new mongoose.Schema({
  _id: { type: String, default: 'heavy-work' },
  revision: { type: Number, default: 0 },
  jobs: { type: [mongoose.Schema.Types.Mixed], default: [] },
  legacy: { type: mongoose.Schema.Types.Mixed, default: null }
}, { collection: 'heavy_work_queue', timestamps: true, minimize: false });

module.exports = mongoose.models.HeavyWorkQueue || mongoose.model('HeavyWorkQueue', schema);
