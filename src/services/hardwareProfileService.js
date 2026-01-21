/**
 * Hardware Profile Service
 * Phase 3 Week 10: Hardware detection and profiling for host categorization
 * Detects VRAM, backend, quantization, and calculates efficiency metrics
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const { getFetchOptions } = require('../helpers/httpAgent');
const HardwareProfile = require('../../models/HardwareProfile');

class HardwareProfileService {
    /**
     * Detect hardware info from Ollama host
     * Uses /api/ps endpoint to get running models and their VRAM usage
     */
    async detectHardware(host, model) {
        try {
            const url = `${host}/api/ps`;
            const fetchOptions = getFetchOptions(url, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            });

            const response = await fetch(url, fetchOptions);

            if (!response.ok) {
                logger.warn('Failed to fetch hardware info from /api/ps', {
                    host,
                    status: response.status
                });
                return this._getFallbackSnapshot(model);
            }

            const data = await response.json();

            // Find the model in the response
            const modelData = data.models?.find(m => m.name === model || m.model === model);

            if (!modelData) {
                logger.debug('Model not found in /api/ps response', { host, model });
                return this._getFallbackSnapshot(model);
            }

            // Extract hardware info
            const snapshot = {
                backend: this._detectBackend(modelData),
                vram_usage_mb: this._extractVramUsage(modelData),
                quantization: this._detectQuantization(model, modelData),
                detection_metadata: {
                    source: 'api/ps',
                    timestamp: new Date().toISOString(),
                    raw: modelData
                }
            };

            logger.debug('Hardware detected', { host, model, snapshot });
            return snapshot;

        } catch (err) {
            logger.warn('Hardware detection failed', {
                host,
                model,
                error: err.message
            });
            return this._getFallbackSnapshot(model);
        }
    }

    /**
     * Extract VRAM usage from model data
     * Ollama reports size_vram in bytes
     */
    _extractVramUsage(modelData) {
        if (modelData.size_vram) {
            return Math.round(modelData.size_vram / (1024 * 1024)); // Convert bytes to MB
        }

        // Fallback: try to parse from size field
        if (modelData.size) {
            const sizeBytes = parseInt(modelData.size, 10);
            if (!isNaN(sizeBytes)) {
                return Math.round(sizeBytes / (1024 * 1024));
            }
        }

        return null;
    }

    /**
     * Detect backend from model data
     * Look for GPU indicators in the response
     */
    _detectBackend(modelData) {
        // Check details field for GPU info
        const details = JSON.stringify(modelData.details || {}).toLowerCase();
        const params = JSON.stringify(modelData.parameters || {}).toLowerCase();
        const combined = (details + ' ' + params).toLowerCase();

        if (combined.includes('cuda') || combined.includes('gpu_layers')) {
            return 'CUDA';
        }
        if (combined.includes('metal')) {
            return 'Metal';
        }
        if (combined.includes('rocm') || combined.includes('amd')) {
            return 'ROCm';
        }
        if (combined.includes('vulkan')) {
            return 'Vulkan';
        }
        if (combined.includes('opencl')) {
            return 'OpenCL';
        }
        if (combined.includes('cpu') || modelData.size_vram === 0) {
            return 'CPU';
        }

        return 'Unknown';
    }

    /**
     * Detect quantization from model name or metadata
     * Common patterns: Q4_0, Q4_K_M, Q5_K_M, Q6_K, Q8_0, F16, F32
     */
    _detectQuantization(modelName, modelData = {}) {
        // Check model name first (most reliable)
        const nameMatch = modelName.match(/[Qq](\d+)_([0KM_]+)|[Ff](\d+)/i);
        if (nameMatch) {
            return nameMatch[0].toUpperCase();
        }

        // Check model details
        const details = JSON.stringify(modelData.details || {});
        const quantMatch = details.match(/["']?quantization["']?\s*:\s*["']([^"']+)["']/i);
        if (quantMatch) {
            return quantMatch[1].toUpperCase();
        }

        // Check for common patterns in details
        if (details.includes('Q4_0') || details.includes('q4_0')) return 'Q4_0';
        if (details.includes('Q4_K_M') || details.includes('q4_k_m')) return 'Q4_K_M';
        if (details.includes('Q5_K_M') || details.includes('q5_k_m')) return 'Q5_K_M';
        if (details.includes('Q6_K') || details.includes('q6_k')) return 'Q6_K';
        if (details.includes('Q8_0') || details.includes('q8_0')) return 'Q8_0';
        if (details.includes('F16') || details.includes('f16')) return 'F16';
        if (details.includes('F32') || details.includes('f32')) return 'F32';

        return null;
    }

    /**
     * Fallback snapshot when hardware detection fails
     * Attempts to extract quantization from model name
     */
    _getFallbackSnapshot(model) {
        return {
            backend: null,
            vram_usage_mb: null,
            quantization: this._detectQuantization(model),
            detection_metadata: {
                source: 'fallback',
                timestamp: new Date().toISOString(),
                note: 'Hardware detection unavailable'
            }
        };
    }

    /**
     * Create or update hardware profile for a model+host combination
     * Aggregates benchmark results to calculate efficiency metrics
     */
    async updateProfile({ host, model, hardwareSnapshot, workspaceId = null }) {
        const BenchmarkResult = require('../../models/BenchmarkResult');

        // Get recent benchmark results for this model+host
        const recentResults = await BenchmarkResult.find({
            host,
            model,
            success: true,
            quality_score: { $ne: null },
            timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // Last 7 days
        }).sort({ timestamp: -1 }).limit(100);

        if (recentResults.length === 0) {
            logger.debug('No results to create profile', { host, model });
            return null;
        }

        // Calculate aggregate metrics
        const avgTokensPerSec = recentResults.reduce((sum, r) => {
            const speed = parseFloat(r.tokens_per_sec) || 0;
            return sum + speed;
        }, 0) / recentResults.length;

        const avgLatency = recentResults.reduce((sum, r) => sum + (r.latency || 0), 0) / recentResults.length;

        const avgQuality = recentResults.reduce((sum, r) => sum + (r.quality_score || 0), 0) / recentResults.length;

        // Find peak VRAM from hardware snapshots
        const vramValues = recentResults
            .map(r => r.hardware_snapshot?.vram_usage_mb)
            .filter(v => v !== null && v !== undefined);
        const vramPeak = vramValues.length > 0 ? Math.max(...vramValues) : null;

        // Create or update profile
        const profileData = {
            host,
            model,
            backend: hardwareSnapshot.backend || 'Unknown',
            vram_usage_mb: hardwareSnapshot.vram_usage_mb,
            vram_peak_mb: vramPeak,
            quantization: hardwareSnapshot.quantization,
            avg_tokens_per_sec: avgTokensPerSec,
            avg_latency_ms: Math.round(avgLatency),
            samples: recentResults.length,
            avg_quality_score: Math.round(avgQuality * 10) / 10,
            detection_metadata: hardwareSnapshot.detection_metadata,
            workspaceId,
            timestamp: new Date()
        };

        const profile = new HardwareProfile(profileData);
        profile.calculateEfficiency();
        await profile.save();

        logger.info('Hardware profile updated', {
            host,
            model,
            samples: recentResults.length,
            vram_efficiency: profile.vram_efficiency,
            speed_efficiency: profile.speed_efficiency
        });

        return profile;
    }

    /**
     * Compare same model across different hosts
     * Returns efficiency comparison data
     */
    async compareHosts(model) {
        const profiles = await HardwareProfile.compareHosts(model);

        if (profiles.length === 0) {
            return {
                model,
                message: 'No hardware profiles found for this model',
                profiles: []
            };
        }

        return {
            model,
            comparison_count: profiles.length,
            profiles: profiles.map(p => ({
                host: p._id,
                host_label: p.host_label,
                backend: p.backend,
                quantization: p.quantization,
                avg_vram_mb: Math.round(p.avg_vram_mb),
                avg_quality: Math.round(p.avg_quality * 10) / 10,
                avg_speed: Math.round(p.avg_speed * 10) / 10,
                vram_efficiency: Math.round(p.avg_efficiency * 10) / 10,
                samples: p.total_samples
            }))
        };
    }

    /**
     * Get optimal quantization for a model
     * Finds quantization with highest efficiency
     */
    async getOptimalQuantization(model, backend = null) {
        const results = await HardwareProfile.getOptimalQuantization(model, backend);

        if (results.length === 0) {
            return {
                model,
                backend,
                message: 'No quantization data found',
                quantizations: []
            };
        }

        return {
            model,
            backend,
            optimal: results[0]._id,
            quantizations: results.map(q => ({
                quantization: q._id,
                avg_vram_mb: Math.round(q.avg_vram_mb),
                avg_quality: Math.round(q.avg_quality * 10) / 10,
                avg_speed: Math.round(q.avg_speed * 10) / 10,
                vram_efficiency: Math.round(q.avg_efficiency * 10) / 10,
                samples: q.samples
            }))
        };
    }

    /**
     * Get backend statistics across all models
     */
    async getBackendStats() {
        const stats = await HardwareProfile.getBackendStats();

        return {
            backends: stats.map(s => ({
                backend: s._id,
                model_count: s.model_count,
                avg_vram_mb: Math.round(s.avg_vram_mb),
                avg_quality: Math.round(s.avg_quality * 10) / 10,
                avg_speed: Math.round(s.avg_speed * 10) / 10,
                total_profiles: s.total_profiles
            }))
        };
    }
}

module.exports = new HardwareProfileService();
