const fs = require('fs');
const path = require('path');

const DEFAULT_GOLDSET_PATH = path.resolve(process.cwd(), 'config', 'benchmark-judge-calibration-goldset.json');

function loadCalibrationSet(filePath = DEFAULT_GOLDSET_PATH) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
}

function validateCalibrationSet(calibrationSet) {
    if (!Array.isArray(calibrationSet) || calibrationSet.length === 0) {
        throw new Error('Calibration set must be a non-empty array');
    }

    for (const entry of calibrationSet) {
        if (!entry.id || !entry.category) {
            throw new Error('Calibration entries require id and category');
        }
        if (!Number.isFinite(entry.level) || entry.level < 1 || entry.level > 10) {
            throw new Error(`Calibration entry ${entry.id} has invalid level`);
        }
        if (!Number.isFinite(entry.human_score) || entry.human_score < 0 || entry.human_score > 10) {
            throw new Error(`Calibration entry ${entry.id} has invalid human_score`);
        }
        if (!Number.isFinite(entry.tolerance) || entry.tolerance <= 0) {
            throw new Error(`Calibration entry ${entry.id} has invalid tolerance`);
        }
    }

    return true;
}

function evaluateCalibrationCase(calibrationCase, actual) {
    const actualScore = Number.isFinite(actual?.quality_score) ? actual.quality_score : null;
    const scoreDelta = actualScore === null
        ? null
        : Math.round(Math.abs(actualScore - calibrationCase.human_score) * 100) / 100;
    const withinTolerance = scoreDelta === null
        ? false
        : scoreDelta <= calibrationCase.tolerance;
    const expectedReview = !!calibrationCase.expected_review;
    const actualReview = !!actual?.needs_review;

    return {
        id: calibrationCase.id,
        category: calibrationCase.category,
        level: calibrationCase.level,
        human_score: calibrationCase.human_score,
        actual_score: actualScore,
        score_delta: scoreDelta,
        tolerance: calibrationCase.tolerance,
        within_tolerance: withinTolerance,
        expected_review: expectedReview,
        actual_review: actualReview,
        review_match: expectedReview === actualReview
    };
}

function summarizeCalibrationResults(results) {
    if (!Array.isArray(results) || results.length === 0) {
        return {
            total_cases: 0,
            scored_cases: 0,
            within_tolerance_rate: 0,
            mae: null,
            review_match_rate: 0
        };
    }

    const scored = results.filter((result) => result.actual_score !== null);
    const withinTolerance = results.filter((result) => result.within_tolerance).length;
    const reviewMatches = results.filter((result) => result.review_match).length;
    const totalDelta = scored.reduce((sum, result) => sum + result.score_delta, 0);

    return {
        total_cases: results.length,
        scored_cases: scored.length,
        within_tolerance_rate: Math.round((withinTolerance / results.length) * 100),
        mae: scored.length > 0 ? Math.round((totalDelta / scored.length) * 100) / 100 : null,
        review_match_rate: Math.round((reviewMatches / results.length) * 100)
    };
}

module.exports = {
    DEFAULT_GOLDSET_PATH,
    loadCalibrationSet,
    validateCalibrationSet,
    evaluateCalibrationCase,
    summarizeCalibrationResults
};
