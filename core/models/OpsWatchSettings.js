'use strict';

const mongoose = require('mongoose');

// Operations watch settings saved from the Nerve Center. One document; when
// it is absent the environment (OPS_WATCH_MS, OPS_WATCH_LANGUAGE) applies.
const OpsWatchSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'ops-watch' },
  enabled: { type: Boolean, required: true },
  intervalMs: { type: Number, required: true, min: 300000, max: 86400000 },
  language: { type: String, required: true, trim: true, maxlength: 30 }
}, { collection: 'ops_watch_settings', timestamps: true });

module.exports = mongoose.models.OpsWatchSettings || mongoose.model('OpsWatchSettings', OpsWatchSettingsSchema);
