/**
 * Composite Scorer
 * Combines quality, latency, and speed into a single composite score
 */

const logger = require('../../../config/logger');
const { CATEGORY_COMPOSITE_PROFILES } = require('./scoringConfigs');

/**
 * Calculate composite score combining speed and quality
 * @param {Object} metrics - Performance and quality metrics
 * @param {String} profileOrCategory - Scoring profile or category name
 * @returns {Object} Composite scores
 */
function calculateCompositeScore(metrics, profileOrCategory = 'interactive') {
    let { latency, tokens_per_sec, quality_score } = metrics;

    latency = Number(latency);
    if (isNaN(latency)) latency = 0;

    tokens_per_sec = parseFloat(tokens_per_sec);
    if (isNaN(tokens_per_sec)) tokens_per_sec = 0;

    quality_score = Number(quality_score);
    if (isNaN(quality_score)) quality_score = 0;

    // Legacy profiles for backward compatibility
    const LEGACY_PROFILES = {
        interactive: {
            weights: { quality: 0.4, latency: 0.4, speed: 0.2 },
            latencyCap: 30000,
            description: "Optimized for user-facing chat"
        },
        reasoning: {
            weights: { quality: 0.8, latency: 0.1, speed: 0.1 },
            latencyCap: 120000,
            description: "Optimized for complex problem solving"
        },
        coding: {
            weights: { quality: 0.7, latency: 0.2, speed: 0.1 },
            latencyCap: 60000,
            description: "Optimized for code generation accuracy"
        }
    };

    let config;
    let profileUsed;

    if (CATEGORY_COMPOSITE_PROFILES[profileOrCategory]) {
        config = CATEGORY_COMPOSITE_PROFILES[profileOrCategory];
        profileUsed = `category:${profileOrCategory}`;
    } else if (LEGACY_PROFILES[profileOrCategory]) {
        config = LEGACY_PROFILES[profileOrCategory];
        profileUsed = `profile:${profileOrCategory}`;
    } else {
        config = LEGACY_PROFILES.interactive;
        profileUsed = 'profile:interactive';
    }

    const weights = config.weights;

    let latencyScore;
    if (latency <= 0) {
        latencyScore = 100;
    } else if (latency >= config.latencyCap) {
        latencyScore = 0;
        logger.debug('Latency exceeds cap', { latency, cap: config.latencyCap });
    } else {
        latencyScore = 100 - ((latency / config.latencyCap) * 100);
    }
    latencyScore = Math.max(0, latencyScore);

    let speedScore;
    if (tokens_per_sec <= 0) {
        speedScore = 0;
    } else if (tokens_per_sec >= 100) {
        speedScore = 100;
    } else {
        speedScore = tokens_per_sec;
    }

    const qualityScore = Math.max(0, Math.min(100, (quality_score || 0) * 10));

    const composite = (
        qualityScore * weights.quality +
        latencyScore * weights.latency +
        speedScore * weights.speed
    );

    return {
        composite_score: Math.round(composite * 10) / 10,
        normalized: {
            quality: Math.round(qualityScore * 10) / 10,
            latency: Math.round(latencyScore * 10) / 10,
            speed: Math.round(speedScore * 10) / 10
        },
        weights,
        profile: profileOrCategory,
        composite_profile_used: profileUsed
    };
}

module.exports = { calculateCompositeScore };
