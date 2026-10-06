/**
 * Scorer Version
 * ==============
 *
 * Single source of truth for the benchmark scoring pipeline identity.
 *
 * Scores are persisted at judging time. Any change to routing, judge prompts,
 * deterministic extractors, or aggregation semantics can change what a stored
 * quality_score means. Historical rows are not rewritten; consumers should
 * filter or label cross-version comparisons instead.
 */

// 2.15.0: positively keyed rubric with NA for conditional questions, task-
// anchored prompt guidelines, known-answer attention probe, and the primary-
// dimension cap on the overall score. Decomposed scores are not comparable
// with 2.14.x rows.
// 2.16.0: graded "how many are missing" questions in every category and a
// creative form dimension as primary. Not comparable with 2.15.x rows.
// 2.17.0: coding prompts with reference tests are scored by executing the
// candidate; correctness comes from the run and the judge keeps the
// secondary dimensions. Not comparable with 2.16.x rows on those prompts.
// 2.18.0: an eighth prompt category, agent (triage, review, diagnosis, watch,
// tool use), with its own judge rubric, and generalist weights spread over
// eight categories. Generalist ranks are not comparable with 2.17.x.
// 2.19.0: a translation not written in the requested language is bounded at
// 1 on both the decomposed and the reference path (category gates). Translation
// grades are not comparable with 2.18.x rows.
// 2.20.0: secondary bounds: a weak dimension a category's quality rests on
// (coding efficiency, instruction completeness, creative originality and
// engagement) holds the overall score. Coding, instruction and creative grades
// are not comparable with 2.19.x rows.
const SCORER_VERSION = '2.20.0';

const SCORER_COMPONENTS = Object.freeze({
    routing: 5,
    generalist: 6,
    judge_prompt: 8,
    judge_parsing: 9,
    confidence: 6,
    judges: 4,
    deterministic: 6,
    composite: 4
});

function versionsComparable(a, b) {
    if (!a || !b) return false;
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    return pa[0] === pb[0] && pa[1] === pb[1];
}

module.exports = {
    SCORER_VERSION,
    SCORER_COMPONENTS,
    versionsComparable
};
