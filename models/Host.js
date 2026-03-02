const mongoose = require('mongoose');

const GpuSchema = new mongoose.Schema({
  index: { type: Number, default: 0 },
  name: { type: String, default: '' },
  vramTotal: { type: Number, default: 0 },   // MiB
  vramUsed: { type: Number, default: 0 },     // MiB
  temperature: { type: Number, default: null },
  utilization: { type: Number, default: null } // percent
}, { _id: false });

const DiskSchema = new mongoose.Schema({
  mount: { type: String, required: true },
  fs: { type: String, default: '' },
  type: { type: String, default: '' },
  total: { type: Number, default: 0 },        // bytes
  used: { type: Number, default: 0 },
  available: { type: Number, default: 0 },
  usagePercent: { type: Number, default: 0 }
}, { _id: false });

const NetInterfaceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  bytesIn: { type: Number, default: 0 },
  bytesOut: { type: Number, default: 0 },
  speed: { type: Number, default: null }       // Mbit/s
}, { _id: false });

const ProcessSchema = new mongoose.Schema({
  pid: Number,
  name: String,
  cpu: Number,
  mem: Number
}, { _id: false });

const HostSchema = new mongoose.Schema({
  hostId: { type: String, required: true, unique: true, index: true },
  hostname: { type: String, required: true },
  platform: { type: String, enum: ['linux', 'win32', 'darwin', 'freebsd', 'unknown'], default: 'unknown' },
  distro: { type: String, default: '' },
  kernel: { type: String, default: '' },
  arch: { type: String, default: '' },
  ip: { type: String, default: '' },
  agentVersion: { type: String, default: '1.0.0' },

  status: { type: String, enum: ['online', 'offline', 'degraded'], default: 'offline', index: true },
  lastSeen: { type: Date, default: null, index: true },

  // CPU
  cpu: {
    model: { type: String, default: '' },
    cores: { type: Number, default: 0 },
    physicalCores: { type: Number, default: 0 },
    speed: { type: Number, default: 0 },       // GHz
    usage: { type: Number, default: 0 },        // percent
    temperature: { type: Number, default: null },
    loadAvg: { type: [Number], default: [] }
  },

  // Memory
  memory: {
    total: { type: Number, default: 0 },        // bytes
    used: { type: Number, default: 0 },          // includes buffers/cache
    available: { type: Number, default: 0 },     // actual available (excl. reclaimable cache)
    buffcache: { type: Number, default: 0 },     // buffer/cache bytes
    free: { type: Number, default: 0 },
    usagePercent: { type: Number, default: 0 }   // based on available, not raw used
  },

  // GPUs
  gpus: { type: [GpuSchema], default: [] },

  // Disks
  disks: { type: [DiskSchema], default: [] },

  // Network
  network: {
    interfaces: { type: [NetInterfaceSchema], default: [] }
  },

  // Top processes
  topProcessesCpu: { type: [ProcessSchema], default: [] },
  topProcessesMem: { type: [ProcessSchema], default: [] },

  // OS uptime
  uptime: { type: Number, default: 0 },         // seconds

  // Ollama integration
  ollamaUrl: { type: String, default: '' },
  ollamaStatus: { type: String, enum: ['online', 'offline', 'unknown', ''], default: '' },
  ollamaModels: { type: [String], default: [] },

  // User-defined tags
  tags: { type: [String], default: [] }
}, {
  timestamps: true,
  collection: 'hosts'
});

// Mark host offline if no heartbeat for 2 minutes
HostSchema.statics.markStaleOffline = async function (thresholdMs = 120000) {
  const cutoff = new Date(Date.now() - thresholdMs);
  const result = await this.updateMany(
    { status: { $ne: 'offline' }, lastSeen: { $lt: cutoff } },
    { $set: { status: 'offline' } }
  );
  return result.modifiedCount;
};

module.exports = mongoose.model('Host', HostSchema);
