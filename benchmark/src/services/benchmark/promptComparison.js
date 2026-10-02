'use strict';

/**
 * Per-prompt comparability on the cohort leaderboard.
 *
 * A quality cohort fixes the judge, scorer version and generation settings;
 * it does not fix the prompts. Each result carries the fingerprint of the
 * prompt it ran (identity and scoring content), and the board compares a
 * result only when that fingerprint is the one the catalog holds today:
 *
 * - a prompt added to the catalog changes nothing for existing results; rows
 *   that have not run it simply do not cover it;
 * - an edited prompt (same id, other content) has a new fingerprint, so the
 *   results that ran its older content leave the comparison, and only those;
 * - a prompt removed from the catalog leaves the comparison.
 *
 * Cohorts written before prompt fingerprints pinned the whole catalog in
 * their own fingerprint; their results carry no prompt fingerprint and the
 * board compares them as one cohort, as before.
 *
 * Rows of one cohort may cover different prompts (a campaign still running,
 * a prompt added since). Each ranked row says which prompts of the board it
 * covers, which it lacks and how many it shares with the leader, so a
 * comparison on a subset is explicit.
 */

const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { GENERALIST_AGGREGATION_OPTIONS } = require('./generalistScoreConstants');
const { buildPromptFingerprint } = require('../../../../shared/benchmarkTargetContract');

const MISSING_PROMPTS_LISTED = 25;

/** fingerprint -> { id, name, category, level } for every catalog prompt as it is today. */
async function loadCatalogPrompts() {
    const catalog = new Map();
    for (const prompt of await BenchmarkPrompt.find({}).lean()) {
        catalog.set(buildPromptFingerprint(prompt), {
            id: String(prompt._id),
            name: prompt.name,
            category: prompt.category,
            level: prompt.level
        });
    }
    return catalog;
}

/**
 * How the board compares prompts inside `cohort`: per prompt when its results
 * carry prompt fingerprints, as one catalog-wide cohort otherwise.
 *
 * @returns {Promise<{ pinned: boolean, catalog: Map|null, fingerprints: string[] }>}
 */
async function promptScopeFor(cohort) {
    if (!cohort) return { pinned: false, catalog: null, fingerprints: [] };
    const pinned = Boolean(await BenchmarkResult.exists({
        quality_cohort_fingerprint: cohort,
        prompt_fingerprint: { $type: 'string' }
    }));
    if (!pinned) return { pinned: false, catalog: null, fingerprints: [] };
    const catalog = await loadCatalogPrompts();
    return { pinned: true, catalog, fingerprints: [...catalog.keys()] };
}

/** Match clause keeping the results that ran a prompt as the catalog holds it. */
function currentPromptClause(scope) {
    return { prompt_fingerprint: { $in: scope.fingerprints } };
}

/**
 * Aggregation expression: true for a result of the selected cohort whose
 * prompt is not in the catalog as it is today (edited, removed or unknown).
 */
function stalePromptExpression(cohort, scope) {
    if (!scope?.pinned) return { $literal: false };
    return {
        $and: [
            { $eq: ['$quality_cohort_fingerprint', cohort] },
            { $not: [{ $in: [{ $ifNull: ['$prompt_fingerprint', ''] }, scope.fingerprints] }] }
        ]
    };
}

/** model@@host -> Set of prompt fingerprints the compared results cover. */
async function promptSetsByEntry(match) {
    const rows = await BenchmarkResult.aggregate([
        { $match: match },
        { $group: { _id: { model: '$model', host: '$host' }, prompts: { $addToSet: '$prompt_fingerprint' } } }
    ], GENERALIST_AGGREGATION_OPTIONS);
    return new Map(rows.map(row => [`${row._id.model}@@${row._id.host}`, new Set(row.prompts.filter(Boolean))]));
}

function describePrompt(catalog, fingerprint) {
    const prompt = catalog.get(fingerprint);
    return prompt ? { name: prompt.name, category: prompt.category, level: prompt.level } : { name: null, category: null, level: null };
}

/**
 * Annotate ranked rows with `promptCoverage` and return the board's prompt
 * set: the prompts any ranked row covers and those every ranked row covers.
 *
 * @param {object[]} rows - ranked rows (one per model and host)
 * @param {Map<string, Set<string>>} promptSets - from promptSetsByEntry
 * @param {Map} catalog - from loadCatalogPrompts
 */
function annotatePromptCoverage(rows, promptSets, catalog) {
    const sets = rows.map(row => promptSets.get(`${row.model}@@${row.host}`) || new Set());
    const board = new Set(sets.flatMap(set => [...set]));
    const sharedByAll = [...board].filter(fingerprint => sets.every(set => set.has(fingerprint)));
    rows.forEach((row, index) => {
        const covered = sets[index];
        const missing = [...board].filter(fingerprint => !covered.has(fingerprint))
            .map(fingerprint => describePrompt(catalog, fingerprint))
            .sort((a, b) => String(a.category).localeCompare(String(b.category))
                || (a.level || 0) - (b.level || 0) || String(a.name).localeCompare(String(b.name)));
        row.promptCoverage = {
            covered: covered.size,
            boardPrompts: board.size,
            sharedByAll: sharedByAll.length,
            missingCount: missing.length,
            missing: missing.slice(0, MISSING_PROMPTS_LISTED),
            sharedWithLeader: null
        };
    });
    return { boardPrompts: board.size, sharedByAll: sharedByAll.length, catalogPrompts: catalog.size };
}

/** Record on each covered row how many prompts it shares with `leader`. */
function annotateSharedWithLeader(rows, promptSets, leader) {
    if (!leader) return;
    const leaderSet = promptSets.get(`${leader.model}@@${leader.host}`) || new Set();
    for (const row of rows) {
        if (!row.promptCoverage) continue;
        const set = promptSets.get(`${row.model}@@${row.host}`) || new Set();
        row.promptCoverage.sharedWithLeader = [...set].filter(fingerprint => leaderSet.has(fingerprint)).length;
    }
}

module.exports = {
    MISSING_PROMPTS_LISTED,
    annotatePromptCoverage,
    annotateSharedWithLeader,
    currentPromptClause,
    loadCatalogPrompts,
    promptScopeFor,
    promptSetsByEntry,
    stalePromptExpression
};
