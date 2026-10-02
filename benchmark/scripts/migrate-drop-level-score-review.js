#!/usr/bin/env node
'use strict';

/**
 * Undo the retired level-score review penalty on stored results.
 *
 * judgeConfidence used to lower the confidence of any score of 8 or more on a
 * level 3-5 prompt and to add "Level-score mismatch penalty: …" to its review
 * reasons. The leaderboard excludes results that need review, so it dropped
 * exactly the good answers to hard prompts. The penalty is removed from the
 * scorer; this script removes it from results scored before that.
 *
 * For each result carrying that reason it adds the penalty back to
 * judge_confidence (the same formula the scorer used), removes the reason, and
 * recomputes needs_review as the scorer does: confidence below 0.7 or a hard
 * trigger (failed attention check, uniform verdicts, truncation) still in the
 * remaining reasons.
 *
 * Usage (inside the benchmark container, MONGODB_URI set):
 *   node scripts/migrate-drop-level-score-review.js [--dry-run]
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';
const DRY_RUN = process.argv.includes('--dry-run');
const REASON = 'Level-score mismatch penalty: high score on difficult prompt may indicate misunderstanding';
const HARD_TRIGGERS = [/attention check/i, /Uniform binary verdicts/i, /truncated/i];

// The retired judgeConfidence penalty, kept here only to reverse it.
function retiredPenalty(level, score) {
    if (!(level >= 3) || !(score >= 8)) return 0;
    return ((level - 2) / 3) * Math.min(1, (score - 7) / 3) * 0.25;
}

function reviewFields(result) {
    const reasons = String(result.review_reason || '').split('; ').filter(reason => reason && reason !== REASON);
    const confidence = typeof result.judge_confidence === 'number'
        ? Math.min(1, Math.round((result.judge_confidence + retiredPenalty(result.prompt_level, result.quality_score)) * 100) / 100)
        : result.judge_confidence;
    const needsReview = (typeof confidence === 'number' && confidence < 0.7)
        || reasons.some(reason => HARD_TRIGGERS.some(trigger => trigger.test(reason)));
    return {
        judge_confidence: confidence,
        needs_review: needsReview,
        review_reason: reasons.length ? reasons.join('; ') : null
    };
}

async function main() {
    await mongoose.connect(MONGO_URI);
    const results = mongoose.connection.collection('benchmarkresults');
    const cursor = results.find({ review_reason: { $regex: 'Level-score mismatch penalty' } },
        { projection: { review_reason: 1, judge_confidence: 1, prompt_level: 1, quality_score: 1, needs_review: 1 } });
    let seen = 0;
    let cleared = 0;
    for await (const result of cursor) {
        seen += 1;
        const fields = reviewFields(result);
        if (result.needs_review && !fields.needs_review) cleared += 1;
        if (!DRY_RUN) await results.updateOne({ _id: result._id }, { $set: fields });
    }
    console.log(`results with the retired reason: ${seen}; no longer needing review: ${cleared}${DRY_RUN ? ' (dry-run)' : ''}`);
    await mongoose.disconnect();
}

if (require.main === module) {
    main().catch(async (error) => {
        console.error(error);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
}

module.exports = { reviewFields, retiredPenalty };
