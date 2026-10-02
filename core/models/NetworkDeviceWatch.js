const mongoose = require('mongoose');

// One row per network MAC that Core has observed in the Data inventory. It
// makes the "new device" alert fire once per device, whatever the alert
// lifecycle does afterwards. Rows recorded by the first run are the baseline.
// `settledAt` is set once the device is handled: baseline, already known when
// first observed, or alerted.
const NetworkDeviceWatchSchema = new mongoose.Schema({
  mac: { type: String, required: true, unique: true },
  firstObservedAt: { type: Date, required: true },
  baseline: { type: Boolean, default: false },
  settledAt: { type: Date, default: null },
  alerted: { type: Boolean, default: false },
}, { collection: 'network_device_watch', versionKey: false });

module.exports = mongoose.model('NetworkDeviceWatch', NetworkDeviceWatchSchema);
