'use strict';
/**
 * Decomposed Judge — Static Question Bank
 *
 * Pure data: category → dimension → [{q, weight, invert?}]
 * Extracted from decomposedJudge.js to keep service files within 600-line limit.
 *
 * Consumed by: src/services/decomposedJudge.js
 */

/**
 * Decomposed questions for each category/dimension.
 * Each question has a weight that contributes to the final score.
 */
const DECOMPOSED_QUESTIONS = {
    coding: {
        correctness: [
            { q: 'Does the solution address the requested coding task or bug?', weight: 0.20 },
            { q: 'Is the bug or root cause correctly identified when debugging is required?', weight: 0.20 },
            { q: 'Would the code or fix produce correct output for typical inputs?', weight: 0.35 },
            { q: 'Does it preserve intended behavior without introducing obvious regressions?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Are naming, structure, and organization easy to follow?', weight: 0.30 },
            { q: 'Is readability improved or maintained compared with the likely original approach?', weight: 0.25 },
            { q: 'Is the logic broken into reasonable, understandable steps?', weight: 0.25 },
            { q: 'Would another developer understand the solution quickly?', weight: 0.20 }
        ],
        efficiency: [
            { q: 'Does the solution avoid obviously inefficient patterns?', weight: 0.35 },
            { q: 'Is the time and space complexity reasonable for the task?', weight: 0.35 },
            { q: 'Does the solution avoid unnecessary complexity or over-engineering?', weight: 0.30 }
        ],
        robustness: [
            { q: 'Does the solution handle null, empty, or invalid inputs appropriately?', weight: 0.30 },
            { q: 'Are appropriate validation or error checks included?', weight: 0.30 },
            { q: 'Are important edge cases still handled after the change?', weight: 0.20 },
            { q: 'Would unexpected input likely cause a crash or obvious failure?', weight: 0.20, invert: true }
        ]
    },
    reasoning: {
        accuracy: [
            { q: 'Is the final conclusion or answer correct?', weight: 0.40 },
            { q: 'Are the intermediate steps and use of prior context accurate?', weight: 0.35 },
            { q: 'Does it avoid factual or interpretive errors while reasoning?', weight: 0.25 }
        ],
        logic_soundness: [
            { q: 'Does each reasoning step logically follow from the previous one?', weight: 0.35 },
            { q: 'Are there contradictions or logical fallacies present?', weight: 0.30, invert: true },
            { q: 'Is the reasoning chain complete and internally consistent?', weight: 0.35 }
        ],
        completeness: [
            { q: 'Does it address all parts of the question or task?', weight: 0.35 },
            { q: 'Are important edge cases, failure modes, or boundary conditions considered?', weight: 0.35 },
            { q: 'Is there enough detail to justify the conclusion?', weight: 0.30 }
        ],
        clarity: [
            { q: 'Is the explanation easy to follow?', weight: 0.40 },
            { q: 'Are assumptions or dependencies clearly stated?', weight: 0.30 },
            { q: 'Is the language precise and unambiguous?', weight: 0.30 }
        ]
    },
    math: {
        answer_correctness: [
            { q: 'Is the final numeric answer correct?', weight: 0.50 },
            { q: 'Is the answer in the expected format?', weight: 0.25 },
            { q: 'Are units correct (if applicable)?', weight: 0.25 }
        ],
        method: [
            { q: 'Is the solution approach valid for this problem?', weight: 0.35 },
            { q: 'Are the right formulas or methods used?', weight: 0.35 },
            { q: 'Are calculation steps shown?', weight: 0.30 }
        ],
        rigor: [
            { q: 'Are all steps mathematically justified?', weight: 0.40 },
            { q: 'Are edge cases or constraints checked?', weight: 0.35 },
            { q: 'Is the solution complete?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Are the steps easy to follow?', weight: 0.50 },
            { q: 'Is notation used correctly?', weight: 0.50 }
        ]
    },
    knowledge: {
        accuracy: [
            { q: 'Are the stated facts, dates, names, or numbers correct?', weight: 0.35 },
            { q: 'Does the response accurately recall relevant provided context when needed?', weight: 0.25 },
            { q: 'Does it avoid common misconceptions or unsupported claims?', weight: 0.20 },
            { q: 'Are claims grounded rather than invented from missing context?', weight: 0.20 }
        ],
        completeness: [
            { q: 'Does it answer the question fully?', weight: 0.40 },
            { q: 'Are important related facts or explanations included?', weight: 0.35 },
            { q: 'Is sufficient context provided for understanding?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Is the information presented clearly?', weight: 0.40 },
            { q: 'Is it well-organized?', weight: 0.30 },
            { q: 'Are technical terms or jargon explained when needed?', weight: 0.30 }
        ],
        objectivity: [
            { q: 'Is the response balanced and unbiased?', weight: 0.35 },
            { q: 'Does it acknowledge limitations or uncertainty where appropriate?', weight: 0.35 },
            { q: 'Does it avoid hallucinating missing context or overstating confidence?', weight: 0.30 }
        ]
    },
    instruction: {
        instruction_adherence: [
            { q: 'Does the response attempt to perform the requested task?', weight: 0.35 },
            { q: 'Does the response address all parts of the instruction?', weight: 0.30 },
            { q: 'When summarization or transformation is requested, are the key points preserved?', weight: 0.20 },
            { q: 'Does the response show clear understanding of what was asked?', weight: 0.15 }
        ],
        constraint_compliance: [
            { q: 'Does the response respect explicit constraints like word limits, language, or tone?', weight: 0.40 },
            { q: 'Does the response contain content that was explicitly forbidden?', weight: 0.35, invert: true },
            { q: 'Does the response include extra unrequested content when only a specific output was asked for?', weight: 0.25, invert: true }
        ],
        format_accuracy: [
            { q: 'Does the response use the same structural format as the expected answer?', weight: 0.50 },
            { q: 'Does the response match the requested separators, delimiters, and key names?', weight: 0.50 }
        ],
        completeness: [
            { q: 'Does the response include all required fields or sections?', weight: 0.35 },
            { q: 'Are any required output elements entirely missing from the response?', weight: 0.25, invert: true },
            { q: 'For summarization tasks, are the major points retained?', weight: 0.25 },
            { q: 'Is the response appropriately brief for the task and constraints?', weight: 0.15 }
        ]
    },
    creative: {
        originality: [
            { q: 'Does the response show creative thinking?', weight: 0.35 },
            { q: 'Does it avoid cliches and generic responses?', weight: 0.35 },
            { q: 'Is there an unexpected or interesting element?', weight: 0.30 }
        ],
        coherence: [
            { q: 'Does the creative content make sense overall?', weight: 0.35 },
            { q: 'Is there a logical structure or conversational flow?', weight: 0.35 },
            { q: 'Are ideas or turns connected naturally?', weight: 0.30 }
        ],
        engagement: [
            { q: 'Is the content interesting or compelling?', weight: 0.35 },
            { q: 'Does it feel natural and engaging when read as dialogue or prose?', weight: 0.35 },
            { q: 'Would it encourage continued reading, interaction, or reflection?', weight: 0.30 }
        ],
        relevance: [
            { q: 'Does it address the prompt or conversational context?', weight: 0.50 },
            { q: 'Does it stay on topic?', weight: 0.50 }
        ]
    },
    translation: {
        accuracy: [
            { q: 'Is the meaning of the original text preserved?', weight: 0.40 },
            { q: 'Are there any mistranslated words or phrases?', weight: 0.35, invert: true },
            { q: 'Are numbers, names, and technical terms correctly handled?', weight: 0.25 }
        ],
        fluency: [
            { q: 'Does the translation read naturally in the target language?', weight: 0.50 },
            { q: 'Is the sentence structure appropriate for the target language?', weight: 0.50 }
        ],
        grammar: [
            { q: 'Is the grammar correct in the target language?', weight: 0.50 },
            { q: 'Is punctuation and capitalization appropriate?', weight: 0.50 }
        ],
        cultural_fit: [
            { q: 'Are idioms and expressions adapted appropriately?', weight: 0.50 },
            { q: 'Is the tone suitable for the target audience?', weight: 0.50 }
        ]
    }
};

module.exports = { DECOMPOSED_QUESTIONS };
