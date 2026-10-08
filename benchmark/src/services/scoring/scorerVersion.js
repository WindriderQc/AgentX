/**
 * Scorer Version
 * ==============
 *
 * Single source of truth for the benchmark scoring pipeline identity.
 *
 * Scores are persisted at judging time. Any change to routing, judge prompts,
 * deterministic extractors, or aggregation semantics can change what a stored
 * quality_score means. A stored grade moves to a later version only through a
 * carry-over declared below (SCORER_CARRY_OVER), which keeps what the row held
 * before in its `scorer_history`. Without one, rows are not rewritten and
 * consumers filter or label cross-version comparisons.
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
// 2.21.0: CommonJS module extraction excludes separately introduced usage and
// wiring examples for test-file fixtures. Coding grades need fresh scoring;
// an old execution failure cannot be corrected from its stored grade alone.
const SCORER_VERSION = '2.21.0';

// What a stored grade needs to stay valid across each version step (#461).
// A category a step does not name kept its meaning: its grades carry over
// unchanged. A named category says how its grades carry over:
//   'secondary_bounds'  the new grade follows from the stored dimension scores
//                       (scoring/gradeCarryOver.js); no judge is called;
//   'judge'             the step asks the judge something new, so the answer
//                       must be scored again.
//   'rescore'           execution or extraction changed; score the saved answer
//                       again rather than carrying its old grade.
// A step with no entry here breaks the chain: every grade before it re-opens.
const SCORER_CARRY_OVER = Object.freeze([
    Object.freeze({ from: '2.18.0', to: '2.19.0', categories: Object.freeze({ translation: 'judge' }) }),
    Object.freeze({ from: '2.19.0', to: '2.20.0', categories: Object.freeze({
        coding: 'secondary_bounds', instruction: 'secondary_bounds', creative: 'secondary_bounds'
    }) }),
    Object.freeze({ from: '2.20.0', to: '2.21.0', categories: Object.freeze({ coding: 'rescore' }) })
]);

const SCORER_COMPONENTS = Object.freeze({
    routing: 5,
    generalist: 6,
    judge_prompt: 8,
    judge_parsing: 9,
    confidence: 6,
    judges: 4,
    deterministic: 7,
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
    SCORER_CARRY_OVER,
    SCORER_COMPONENTS,
    versionsComparable
};
