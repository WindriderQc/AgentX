#!/usr/bin/env node
'use strict';

/**
 * Re-assign benchmark results to the quality cohort as new batches and judge
 * runs compute it.
 *
 * The cohort covers the judge, scorer version, generation settings and
 * profile contract; each result pins the prompt it ran with prompt_id and
 * prompt_fingerprint. Older results carry a cohort fingerprint over the whole
 * catalog of their day and no prompt fingerprint, so any catalog edit left
 * them out of the comparison. For each named batch this script gives every
 * result the fingerprint of the catalog prompt its snapshot provably matches
 * (name, level, category, expected and reference answers, prompt text) and
 * the cohort of the judge that actually judged the batch. A result whose
 * snapshot matches no current catalog prompt (its prompt was edited or
 * removed since) gets no prompt fingerprint and no cohort: it is not
 * compared and needs a rerun. Run with --dry-run first to see the counts.
 *
 * Idempotent: results that already carry a prompt fingerprint keep it, and
 * the cohort is recomputed to the same value.
 *
 * Usage (inside the benchmark container, MONGODB_URI set):
 *   node scripts/migrate-quality-cohorts.js --tag campaign-2026-09-23 [--dry-run]
 *   node scripts/migrate-quality-cohorts.js --batch <id> [--batch <id> ...] [--dry-run]
 *   node scripts/migrate-quality-cohorts.js --all [--dry-run]
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
    const all = process.argv.includes('--all');
    if (!all && !tags.length && !ids.length) {
        console.error('Name the batches: --tag <tag>, --batch <id> or --all');
        process.exit(2);
    }
    await mongoose.connect(MONGO_URI);
    const BenchmarkBatch = require('../models/BenchmarkBatch');
    const BenchmarkResult = require('../models/BenchmarkResult');
    const { applyJudgeCohort, cohortFingerprintForBatch, recoverPromptFingerprints } = require('../src/services/benchmark/qualityCohort');

    const filter = all ? {} : { $or: [] };
    if (!all && tags.length) filter.$or.push({ tags: { $in: tags } });
    if (!all && ids.length) filter.$or.push({ _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) } });
    const batches = await BenchmarkBatch.find(filter).sort({ _id: 1 }).lean();

    for (const batch of batches) {
        const judge = await effectiveJudge(BenchmarkResult, batch);
        const results = await BenchmarkResult.countDocuments({ batch_id: batch._id });
        // Counted before applying: applyJudgeCohort recovers the same prompts.
        const prompts = await recoverPromptFingerprints(batch._id, { dryRun: true });
        const fingerprint = DRY_RUN
            ? await cohortFingerprintForBatch(batch, judge)
            : await applyJudgeCohort(batch._id, judge);
        console.log([batch._id.toString(), batch.run_name || '', `results=${results}`,
            `judge=${judge.model}@${judge.host}`, `cohort=${String(fingerprint).slice(0, 12)}`,
            `prompts recovered=${prompts.recovered} unrecovered=${prompts.unrecovered}`,
            DRY_RUN ? 'dry-run' : 'updated'].join(' | '));
    }
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
