'use strict';

/**
 * Category gates: a yes/no question a response must pass before its grade
 * means anything for the category. A response that fails one is bounded at
 * GATE_BOUND whatever its other answers, on both the decomposed and the
 * reference path (#438).
 *
 * Translation is the only gated category: no rubric question asks whether
 * the response is in the requested language, so a faithful translation into
 * the wrong language kept its accuracy (meaning preserved, nothing omitted)
 * and scored 4.5 to 7 instead of failing the task.
 *
 * A gate is asked once per scored response. Its answer is evidence, recorded
 * with the result; an unanswered gate leaves the grade unreliable like any
 * other failed judge call.
 */

const GATE_BOUND = 1;

const CATEGORY_GATES = Object.freeze({
    translation: Object.freeze([
        Object.freeze({
            key: 'target_language',
            // "The language only" keeps an incomplete translation from failing it (a 4B judge did).
            q: 'Is the response written in the language the task asks the text to be translated into? Judge the language only, not accuracy or completeness. Names, code, placeholders and terms the task keeps unchanged do not count against it.'
        })
    ])
});

/**
 * Ask the category's gates.
 * @param {string} category - normalized scoring category
 * @param {(question: string) => Promise<boolean|null>} ask - one judge call
 * @returns {Promise<Array<{key, question, answer}>>} empty when ungated
 */
async function assessGates(category, ask) {
    const gates = [];
    for (const gate of CATEGORY_GATES[category] || []) {
        const answer = await ask(gate.q);
        gates.push({ key: gate.key, question: gate.q, answer: typeof answer === 'boolean' ? answer : null });
    }
    return gates;
}

const gatesAnswered = gates => gates.every(gate => typeof gate.answer === 'boolean');
const failedGates = gates => gates.filter(gate => gate.answer === false);

/** The score bounded by any failed gate. */
function boundByGates(score, gates) {
    return failedGates(gates).length && typeof score === 'number' ? Math.min(score, GATE_BOUND) : score;
}

module.exports = {
    CATEGORY_GATES,
    GATE_BOUND,
    assessGates,
    boundByGates,
    failedGates,
    gatesAnswered
};
