'use strict';

const mongoose = require('mongoose');

// The mode a runtime topology group is meant to run (#360, phase 4). Set when
// a mode is first observed active, and by each completed switch. Endpoints of
// the group's other modes are parked: stopped on purpose, never alerted on.
const RuntimeTopologyIntentSchema = new mongoose.Schema({
  groupId: { type: String, required: true, unique: true, maxlength: 64 },
  mode: { type: String, required: true, maxlength: 64 },
  source: { type: String, required: true, enum: ['observed', 'switch'] }
}, { collection: 'runtime_topology_intents', timestamps: true });

module.exports = mongoose.models.RuntimeTopologyIntent
  || mongoose.model('RuntimeTopologyIntent', RuntimeTopologyIntentSchema);
