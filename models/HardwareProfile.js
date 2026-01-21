/**
 * HardwareProfile Model
 * Tracks hardware capabilities and resource usage for benchmark hosts
 * Phase 3 Week 10: Hardware profiling for host categorization
 */

const mongoose = require('mongoose');

const HardwareProfileSchema = new mongoose.Schema({
    // Host identification
    host: {
        type: String,
        required: true,
        index: true,
        description: 'Ollama host URL (e.g., http://192.168.1.100:11434)'
    },
    host_label: {
        type: String,
        default: null,
        description: 'User-friendly label for the host (e.g., "Mac Studio M2 Max", "RTX 4090 Server")'
    },

    // Model being profiled
    model: {
        type: String,
        required: true,
        index: true,
        description: 'Model name (e.g., "llama3.1:70b-instruct-q4_K_M")'
    },

    // Hardware detection
    backend: {
        type: String,
        enum: ['CPU', 'CUDA', 'Metal', 'ROCm', 'Vulkan', 'OpenCL', 'Unknown'],
        default: 'Unknown',
        index: true,
        description: 'Compute backend detected during model loading'
    },
    vram_usage_mb: {
        type: Number,
        default: null,
        description: 'VRAM usage in megabytes (from /api/ps endpoint)'
    },
    vram_peak_mb: {
        type: Number,
        default: null,
        description: 'Peak VRAM usage observed during benchmarking'
    },
    quantization: {
        type: String,
        default: null,
        index: true,
        description: 'Detected quantization method (Q4_0, Q4_K_M, Q5_K_M, Q6_K, Q8_0, F16, F32)'
    },

    // Performance metrics
    avg_tokens_per_sec: {
        type: Number,
        default: null,
        description: 'Average generation speed'
    },
    avg_latency_ms: {
        type: Number,
        default: null,
        description: 'Average response latency'
    },
    samples: {
        type: Number,
        default: 0,
        description: 'Number of benchmark tests included in this profile'
    },

    // Quality metrics
    avg_quality_score: {
        type: Number,
        min: 0,
        max: 100,
        default: null,
        description: 'Average quality score across all benchmarks'
    },

    // Efficiency metrics
    vram_efficiency: {
        type: Number,
        default: null,
        description: 'Quality score per GB of VRAM (quality / VRAM_GB)'
    },
    speed_efficiency: {
        type: Number,
        default: null,
        description: 'Quality * tokens_per_sec (higher is better)'
    },

    // Raw detection data
    detection_metadata: {
        type: Object,
        default: null,
        description: 'Raw response from /api/ps or model info endpoint'
    },

    // Multi-tenancy
    workspaceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Workspace',
        required: false,
        index: true
    },

    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: { createdAt: 'timestamp', updatedAt: 'updated_at' }
});

// Compound indexes for analytics queries
HardwareProfileSchema.index({ host: 1, model: 1 });
HardwareProfileSchema.index({ model: 1, backend: 1 });
HardwareProfileSchema.index({ model: 1, quantization: 1 });
HardwareProfileSchema.index({ backend: 1, vram_usage_mb: 1 });

// Static helper methods
HardwareProfileSchema.statics.getByHost = function(host, options = {}) {
    return this.find({ host })
        .sort({ timestamp: -1 })
        .limit(options.limit || 100);
};

HardwareProfileSchema.statics.getByModel = function(model, options = {}) {
    return this.find({ model })
        .sort({ vram_efficiency: -1 })
        .limit(options.limit || 100);
};

HardwareProfileSchema.statics.compareHosts = async function(model) {
    /**
     * Compare same model across different hosts
     * Returns array of profiles sorted by vram_efficiency
     */
    return this.aggregate([
        { $match: { model, samples: { $gte: 3 } } },
        {
            $group: {
                _id: '$host',
                host_label: { $first: '$host_label' },
                backend: { $first: '$backend' },
                quantization: { $first: '$quantization' },
                avg_vram_mb: { $avg: '$vram_usage_mb' },
                avg_quality: { $avg: '$avg_quality_score' },
                avg_speed: { $avg: '$avg_tokens_per_sec' },
                avg_efficiency: { $avg: '$vram_efficiency' },
                total_samples: { $sum: '$samples' }
            }
        },
        { $sort: { avg_efficiency: -1 } }
    ]);
};

HardwareProfileSchema.statics.getOptimalQuantization = async function(model, backend = null) {
    /**
     * Find optimal quantization for a model (highest efficiency)
     * Optionally filter by backend
     */
    const matchStage = { model, samples: { $gte: 3 } };
    if (backend) {
        matchStage.backend = backend;
    }

    return this.aggregate([
        { $match: matchStage },
        {
            $group: {
                _id: '$quantization',
                avg_vram_mb: { $avg: '$vram_usage_mb' },
                avg_quality: { $avg: '$avg_quality_score' },
                avg_speed: { $avg: '$avg_tokens_per_sec' },
                avg_efficiency: { $avg: '$vram_efficiency' },
                samples: { $sum: '$samples' }
            }
        },
        { $sort: { avg_efficiency: -1 } }
    ]);
};

HardwareProfileSchema.statics.getBackendStats = async function() {
    /**
     * Get aggregate stats per backend type
     */
    return this.aggregate([
        { $match: { samples: { $gte: 3 } } },
        {
            $group: {
                _id: '$backend',
                unique_models: { $addToSet: '$model' },
                avg_vram_mb: { $avg: '$vram_usage_mb' },
                avg_quality: { $avg: '$avg_quality_score' },
                avg_speed: { $avg: '$avg_tokens_per_sec' },
                total_profiles: { $sum: 1 }
            }
        },
        {
            $project: {
                backend: '$_id',
                model_count: { $size: '$unique_models' },
                avg_vram_mb: 1,
                avg_quality: 1,
                avg_speed: 1,
                total_profiles: 1
            }
        },
        { $sort: { avg_speed: -1 } }
    ]);
};

// Instance methods
HardwareProfileSchema.methods.calculateEfficiency = function() {
    /**
     * Calculate efficiency metrics
     * avg_quality_score is normalized to 0-10 scale for consistent efficiency calculations
     */
    if (this.vram_usage_mb && this.avg_quality_score) {
        const vramGb = this.vram_usage_mb / 1024;
        if (vramGb > 0) {  // Prevent division by zero
            // Normalize quality to 0-10 scale (handle both 0-10 and 0-100 values)
            const normalizedQuality = this.avg_quality_score > 10
                ? this.avg_quality_score / 10
                : this.avg_quality_score;
            this.vram_efficiency = (normalizedQuality / vramGb).toFixed(2);
        } else {
            this.vram_efficiency = null;  // Cannot calculate efficiency for 0 VRAM
        }
    }

    if (this.avg_quality_score && this.avg_tokens_per_sec) {
        // Normalize quality to 0-10 scale (handle both 0-10 and 0-100 values)
        const normalizedQuality = this.avg_quality_score > 10
            ? this.avg_quality_score / 10
            : this.avg_quality_score;
        this.speed_efficiency = (normalizedQuality * this.avg_tokens_per_sec).toFixed(2);
    }

    return this;
};

module.exports = mongoose.model('HardwareProfile', HardwareProfileSchema);
