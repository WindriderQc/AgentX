#!/usr/bin/env node
'use strict';

/**
 * Re-assign benchmark results to the catalog-wide quality cohort.
 *
 * Until 2026-09-24 the cohort fingerprint covered the prompts one batch
 * selected, so a campaign run one level per batch produced one cohort per
 * batch and the leaderboard compared none of them. A re-judge also left the
 * first judge's cohort on its results. This script recomputes the cohort of
 * each named batch the way new batches and judge runs now do: over the whole
 * catalog, with the judge that actually judged the batch.
 *
 * Usage (inside the benchmark container, MONGODB_URI set):
 *   node scripts/migrate-quality-cohorts.js --tag campaign-2026-09-23 [--dry-run]
 *   node scripts/migrate-quality-cohorts.js --batch <id> [--batch <id> ...] [--dry-run]
 *
 * The judge of a batch is the judge recorded on its LLM-judged results
 * (the most frequent judge model and host); a batch whose results were all
 * scored without a judge keeps its batch judge_config.
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';
const DRY_RUN = process.argv.includes('--dry-run');

function argValues(flag) {
    const values = [];
    process.argv.forEach((arg, index) => {
        if (arg === flag && process.argv[index + 1]) values.push(process.argv[index + 1]);
    });
    return values;
}

async function effectiveJudge(BenchmarkResult, batch) {
    const [top] = await BenchmarkResult.aggregate([
        { $match: { batch_id: batch._id, judge_model: { $type: 'string' }, scoring_method: { $nin: ['deterministic', 'pending', 'llm_failed'] } } },
        { $group: { _id: { model: '$judge_model', host: '$judge_host' }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 1 }
    ]);
    if (top?._id?.model && top._id.host) return { model: top._id.model, host: top._id.host };
    return batch.judge_config || {};
}

async function main() {
    const tags = argValues('--tag');
    const ids = argValues('--batch');
    if (!tags.length && !ids.length) {
        console.error('Name the batches: --tag <tag> or --batch <id>');
        process.exit(2);
    }
    await mongoose.connect(MONGO_URI);
    const BenchmarkBatch = require('../models/BenchmarkBatch');
    const BenchmarkResult = require('../models/BenchmarkResult');
    const { applyJudgeCohort, cohortFingerprintForBatch } = require('../src/services/benchmark/qualityCohort');

    const filter = { $or: [] };
    if (tags.length) filter.$or.push({ tags: { $in: tags } });
    if (ids.length) filter.$or.push({ _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } });
    const batches = await BenchmarkBatch.find(filter).sort({ _id: 1 }).lean();

    for (const batch of batches) {
        const judge = await effectiveJudge(BenchmarkResult, batch);
        const results = await BenchmarkResult.countDocuments({ batch_id: batch._id });
        const fingerprint = DRY_RUN
            ? await cohortFingerprintForBatch(batch, judge)
            : await applyJudgeCohort(batch._id, judge);
        console.log([batch._id.toString(), batch.run_name || '', `results=${results}`,
            `judge=${judge.model}@${judge.host}`, `cohort=${String(fingerprint).slice(0, 12)}`,
            DRY_RUN ? 'dry-run' : 'updated'].join(' | '));
    }
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
