/**
 * Benchmark Initialization Module
 * Handles seeding, cleanup, and initial setup
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { validateCategoryParity } = require('./categoryParity');

const PROMPT_LIBRARY_FILES = [
    'benchmark-prompts.json',
    'benchmark-prompts-enhanced.json',
    'benchmark-prompts-deep.json'
];

function promptIdentityKey(prompt) {
    const category = String(prompt && prompt.category ? prompt.category : '').trim().toLowerCase();
    const name = String(prompt && prompt.name ? prompt.name : '').trim().toLowerCase();
    const level = Number(prompt && prompt.level);
    return `${category}::${name}::${Number.isFinite(level) ? level : ''}`;
}

function toBoundedNumber(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
}

function sanitizePromptRecord(rawPrompt, sourceFile) {
    const name = String(rawPrompt && rawPrompt.name ? rawPrompt.name : '').trim();
    const prompt = String(rawPrompt && rawPrompt.prompt ? rawPrompt.prompt : '').trim();
    const category = String(rawPrompt && rawPrompt.category ? rawPrompt.category : '').trim();
    const level = toBoundedNumber(rawPrompt && rawPrompt.level, 1, 10);

    if (!name || !prompt || !category || level === null) {
        logger.warn('Skipping invalid prompt record in benchmark library', {
            sourceFile,
            name: name || null,
            category: category || null,
            level: rawPrompt && rawPrompt.level !== undefined ? rawPrompt.level : null
        });
        return null;
    }

    const expectedTokens = toBoundedNumber(rawPrompt.expected_tokens, 10, 10000);
    const scoringType = rawPrompt && rawPrompt.scoring_type ? String(rawPrompt.scoring_type).trim() : null;
    const expectedAnswer = rawPrompt && rawPrompt.expected_answer ? String(rawPrompt.expected_answer) : null;
    const referenceAnswer = rawPrompt && rawPrompt.reference_answer ? String(rawPrompt.reference_answer) : null;

    const sanitized = {
        name,
        prompt,
        level,
        category
    };

    if (expectedAnswer) sanitized.expected_answer = expectedAnswer;
    if (expectedTokens !== null) sanitized.expected_tokens = expectedTokens;
    if (scoringType) sanitized.scoring_type = scoringType;
    if (referenceAnswer) sanitized.reference_answer = referenceAnswer;

    if (rawPrompt && rawPrompt.deterministic_scoring && typeof rawPrompt.deterministic_scoring === 'object') {
        sanitized.deterministic_scoring = rawPrompt.deterministic_scoring;
    }

    if (Array.isArray(rawPrompt && rawPrompt.judge_criteria) && rawPrompt.judge_criteria.length > 0) {
        sanitized.judge_criteria = rawPrompt.judge_criteria;
    }

    if (Array.isArray(rawPrompt && rawPrompt.scoring_dimensions) && rawPrompt.scoring_dimensions.length > 0) {
        sanitized.scoring_dimensions = rawPrompt.scoring_dimensions;
    }

    return sanitized;
}

async function loadPromptLibraryRecords() {
    const records = [];

    for (const fileName of PROMPT_LIBRARY_FILES) {
        const promptsPath = path.join(__dirname, '..', '..', '..', 'data', fileName);

        try {
            const promptsData = await fs.readFile(promptsPath, 'utf-8');
            const parsed = JSON.parse(promptsData);

            if (!Array.isArray(parsed)) {
                logger.warn('Benchmark prompt library file is not an array; skipping', { file: fileName });
                continue;
            }

            for (const rawPrompt of parsed) {
                const sanitized = sanitizePromptRecord(rawPrompt, fileName);
                if (sanitized) records.push(sanitized);
            }
        } catch (err) {
            logger.warn('Failed to load benchmark prompt library file', {
                file: fileName,
                error: err.message
            });
        }
    }

    return records;
}

/**
 * Seed/sync benchmark prompts from local library files.
 * Inserts only missing prompts using category+name+level identity.
 */
async function seedPrompts() {
    const libraryRecords = await loadPromptLibraryRecords();
    if (libraryRecords.length === 0) {
        logger.warn('No benchmark prompts loaded from prompt library files');
        return 0;
    }

    const existing = await BenchmarkPrompt.find({}, 'name category level').lean();
    const existingKeys = new Set(existing.map(promptIdentityKey));
    const stagedKeys = new Set();
    const promptsToInsert = [];

    for (const record of libraryRecords) {
        const key = promptIdentityKey(record);
        if (!key || existingKeys.has(key) || stagedKeys.has(key)) continue;
        stagedKeys.add(key);
        promptsToInsert.push(record);
    }

    if (promptsToInsert.length === 0) {
        logger.debug('Benchmark prompt library already synchronized', {
            existingCount: existing.length,
            libraryCount: libraryRecords.length
        });
        await validateCategoryParity();
        return 0;
    }

    let insertedCount = 0;
    try {
        const inserted = await BenchmarkPrompt.insertMany(promptsToInsert, { ordered: false });
        insertedCount = Array.isArray(inserted) ? inserted.length : 0;
    } catch (err) {
        if (err && err.writeErrors && Array.isArray(err.writeErrors)) {
            insertedCount = Math.max(0, promptsToInsert.length - err.writeErrors.length);
            logger.warn('Partial benchmark prompt sync completed with write errors', {
                attempted: promptsToInsert.length,
                inserted: insertedCount,
                writeErrors: err.writeErrors.length
            });
        } else {
            throw err;
        }
    }

    logger.info('Seeded benchmark prompts', {
        inserted: insertedCount,
        promptLibraryCount: libraryRecords.length,
        sourceFiles: PROMPT_LIBRARY_FILES
    });

    await validateCategoryParity();
    return insertedCount;
}

/**
 * Cleanup stale batches on startup
 */
async function cleanupStaleBatches() {
    try {
        const count = await BenchmarkBatch.cleanupStale();
        if (count > 0) {
            logger.info('Cleaned up stale batches', { count });
        }
        return count;
    } catch (err) {
        logger.error('Failed to cleanup stale batches', { error: err.message });
        throw err;
    }
}

/**
 * Get all prompts grouped by level
 */
async function getPrompts() {
    await seedPrompts();
    const { prompts, byLevel } = await BenchmarkPrompt.getAllGroupedByLevel();

    return {
        prompts,
        by_level: byLevel,
        total: prompts.length
    };
}

/**
 * Get configuration presets for common test scenarios
 */
function getConfigPresets() {
    return {
        presets: [
            {
                id: 'quick-test',
                name: 'Quick Test',
                description: 'Fast validation test with simple prompts',
                config: {
                    levels: [1, 2],
                    quality_scoring: false,
                    judge_config: null
                },
                recommended_for: 'Initial model validation, quick checks',
                estimated_duration: '2-5 minutes'
            },
            {
                id: 'standard-benchmark',
                name: 'Standard Benchmark',
                description: 'Balanced test across all levels with quality scoring',
                config: {
                    levels: [1, 2, 3, 4, 5],
                    quality_scoring: true,
                    judge_config: {
                        concurrency: 2,
                        judge_same_host: false
                    }
                },
                recommended_for: 'Regular model evaluation',
                estimated_duration: '15-30 minutes'
            },
            {
                id: 'deep-quality',
                name: 'Deep Quality Analysis',
                description: 'Comprehensive quality scoring on complex prompts',
                config: {
                    levels: [3, 4, 5],
                    quality_scoring: true,
                    judge_config: {
                        concurrency: 1,
                        judge_same_host: false,
                        timeout: 60000
                    }
                },
                recommended_for: 'In-depth model analysis, publication-ready benchmarks',
                estimated_duration: '30-60 minutes'
            },
            {
                id: 'speed-test',
                name: 'Speed Test',
                description: 'Focus on latency and throughput measurement',
                config: {
                    levels: [1, 2],
                    quality_scoring: false,
                    judge_config: null
                },
                recommended_for: 'Performance optimization, latency testing',
                estimated_duration: '5-10 minutes'
            },
            {
                id: 'reasoning-test',
                name: 'Reasoning & Logic',
                description: 'Test logical reasoning and problem-solving',
                config: {
                    levels: [3, 4],
                    quality_scoring: true,
                    judge_config: {
                        concurrency: 2,
                        judge_same_host: false
                    }
                },
                recommended_for: 'Evaluating reasoning capabilities',
                estimated_duration: '20-40 minutes'
            }
        ]
    };
}

module.exports = {
    seedPrompts,
    cleanupStaleBatches,
    getPrompts,
    getConfigPresets
};
