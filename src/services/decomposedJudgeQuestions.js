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
    code: {
        correctness: [
            { q: 'Does the code appear syntactically valid?', weight: 0.15 },
            { q: 'Does the code address the requested task?', weight: 0.25 },
            { q: 'Would it produce correct output for basic inputs?', weight: 0.35 },
            { q: 'Does it handle obvious edge cases?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Are variable and function names descriptive?', weight: 0.30 },
            { q: 'Is the code structure easy to follow?', weight: 0.30 },
            { q: 'Is the logic broken into reasonable steps?', weight: 0.25 },
            { q: 'Would a developer understand this quickly?', weight: 0.15 }
        ],
        efficiency: [
            { q: 'Does the code avoid obviously inefficient patterns?', weight: 0.35 },
            { q: 'Are loops and iterations reasonably optimized?', weight: 0.35 },
            { q: 'Is memory usage sensible for the task?', weight: 0.30 }
        ],
        robustness: [
            { q: 'Does the code handle null or empty inputs?', weight: 0.35 },
            { q: 'Are there appropriate error checks?', weight: 0.35 },
            { q: 'Would unexpected input cause a crash?', weight: 0.30, invert: true }
        ]
    },
    reasoning: {
        accuracy: [
            { q: 'Is the final conclusion or answer correct?', weight: 0.40 },
            { q: 'Are the intermediate steps accurate?', weight: 0.35 },
            { q: 'Does it avoid factual errors?', weight: 0.25 }
        ],
        logic_soundness: [
            { q: 'Does each step logically follow from the previous?', weight: 0.35 },
            { q: 'Are there any logical fallacies present?', weight: 0.30, invert: true },
            { q: 'Is the reasoning chain complete?', weight: 0.35 }
        ],
        clarity: [
            { q: 'Is the explanation easy to follow?', weight: 0.40 },
            { q: 'Are assumptions clearly stated?', weight: 0.30 },
            { q: 'Is the language precise and unambiguous?', weight: 0.30 }
        ],
        completeness: [
            { q: 'Does it address all parts of the question?', weight: 0.40 },
            { q: 'Are important edge cases considered?', weight: 0.30 },
            { q: 'Is the reasoning sufficiently detailed?', weight: 0.30 }
        ]
    },
    factual: {
        accuracy: [
            { q: 'Are the stated facts correct?', weight: 0.40 },
            { q: 'Are dates, numbers, and names accurate?', weight: 0.30 },
            { q: 'Does it avoid common misconceptions?', weight: 0.30 }
        ],
        completeness: [
            { q: 'Does it answer the question fully?', weight: 0.40 },
            { q: 'Are important related facts included?', weight: 0.35 },
            { q: 'Is sufficient context provided?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Is the information presented clearly?', weight: 0.40 },
            { q: 'Is it well-organized?', weight: 0.30 },
            { q: 'Is jargon explained when used?', weight: 0.30 }
        ],
        objectivity: [
            { q: 'Is the response balanced and unbiased?', weight: 0.50 },
            { q: 'Does it acknowledge limitations or uncertainty?', weight: 0.50 }
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
    creative: {
        originality: [
            { q: 'Does the response show creative thinking?', weight: 0.35 },
            { q: 'Does it avoid cliches and generic responses?', weight: 0.35 },
            { q: 'Is there an unexpected or interesting element?', weight: 0.30 }
        ],
        coherence: [
            { q: 'Does the creative content make sense?', weight: 0.40 },
            { q: 'Is there a logical structure or flow?', weight: 0.35 },
            { q: 'Are ideas connected well?', weight: 0.25 }
        ],
        engagement: [
            { q: 'Is the content interesting or compelling?', weight: 0.40 },
            { q: 'Would someone want to read/see more?', weight: 0.35 },
            { q: 'Does it evoke emotion or thought?', weight: 0.25 }
        ],
        relevance: [
            { q: 'Does it address the creative prompt?', weight: 0.50 },
            { q: 'Does it stay on topic?', weight: 0.50 }
        ]
    },
    'instruction-following': {
        instruction_adherence: [
            { q: 'Does the response attempt to perform the requested task (ignoring whether computed values are correct)?', weight: 0.40 },
            { q: 'Does the response address all parts of the instruction (even if some values are wrong)?', weight: 0.35 },
            { q: 'Does the response show understanding of what was asked?', weight: 0.25 }
        ],
        constraint_compliance: [
            { q: 'Does the response respect explicit constraints like word limits, language, or tone?', weight: 0.40 },
            { q: 'Does the response contain content that was explicitly forbidden?', weight: 0.35, invert: true },
            { q: 'Does the response include extra unrequested content like explanations when only a value was asked?', weight: 0.25, invert: true }
        ],
        format_accuracy: [
            { q: 'Does the response use the same structural format as the expected answer (ignore whether values are correct)?', weight: 0.50 },
            { q: 'Does the response match the requested separators, delimiters, and key names (ignore value correctness)?', weight: 0.50 }
        ],
        completeness: [
            { q: 'Does the response include all the required fields or sections (ignore whether values are correct)?', weight: 0.50 },
            { q: 'Are any required output elements entirely missing from the response?', weight: 0.50, invert: true }
        ]
    },
    general: {
        helpfulness: [
            { q: 'Does the response help achieve the user goal?', weight: 0.40 },
            { q: 'Is actionable information provided?', weight: 0.35 },
            { q: 'Would the user be satisfied?', weight: 0.25 }
        ],
        relevance: [
            { q: 'Does the response stay on topic?', weight: 0.50 },
            { q: 'Is irrelevant information avoided?', weight: 0.50 }
        ],
        clarity: [
            { q: 'Is the response easy to understand?', weight: 0.50 },
            { q: 'Is it well-organized?', weight: 0.50 }
        ],
        accuracy: [
            { q: 'Is the information factually correct?', weight: 0.60 },
            { q: 'Are claims supported or verifiable?', weight: 0.40 }
        ]
    },
    summarization: {
        accuracy: [
            { q: 'Does the summary preserve the key information from the original?', weight: 0.40 },
            { q: 'Are any facts in the summary incorrect or distorted?', weight: 0.35, invert: true },
            { q: 'Does it capture the main point or conclusion?', weight: 0.25 }
        ],
        conciseness: [
            { q: 'Is the summary appropriately brief for the task?', weight: 0.40 },
            { q: 'Does it meet any specified length or word count constraints?', weight: 0.35 },
            { q: 'Is unnecessary detail avoided?', weight: 0.25 }
        ],
        completeness: [
            { q: 'Are all major points from the source included?', weight: 0.50 },
            { q: 'Is any critical information missing?', weight: 0.50, invert: true }
        ],
        coherence: [
            { q: 'Does the summary read as a coherent standalone text?', weight: 0.50 },
            { q: 'Is the summary logically structured?', weight: 0.50 }
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
    },
    explanation: {
        clarity: [
            { q: 'Is the explanation easy to follow?', weight: 0.40 },
            { q: 'Are technical terms defined or explained?', weight: 0.30 },
            { q: 'Are examples or analogies used effectively?', weight: 0.30 }
        ],
        accuracy: [
            { q: 'Is the explanation technically correct?', weight: 0.50 },
            { q: 'Are there any misleading statements?', weight: 0.50, invert: true }
        ],
        structure: [
            { q: 'Is the explanation logically ordered?', weight: 0.50 },
            { q: 'Does it build from simple to complex concepts?', weight: 0.50 }
        ],
        completeness: [
            { q: 'Are the key aspects of the topic covered?', weight: 0.60 },
            { q: 'Is important context provided?', weight: 0.40 }
        ]
    },
    debugging: {
        root_cause: [
            { q: 'Is the actual bug or issue correctly identified?', weight: 0.50 },
            { q: 'Is the root cause explained, not just symptoms?', weight: 0.50 }
        ],
        fix_correctness: [
            { q: 'Does the proposed fix address the root cause?', weight: 0.50 },
            { q: 'Would the fix work without introducing new bugs?', weight: 0.50 }
        ],
        minimal_intervention: [
            { q: 'Is the fix minimal and focused?', weight: 0.50 },
            { q: 'Are unrelated changes avoided?', weight: 0.50 }
        ],
        explanation: [
            { q: 'Is the reason for the bug clearly explained?', weight: 0.50 },
            { q: 'Would a developer understand the fix from the explanation?', weight: 0.50 }
        ]
    },
    refactoring: {
        readability_improvement: [
            { q: 'Is the refactored code more readable?', weight: 0.40 },
            { q: 'Are naming conventions improved?', weight: 0.30 },
            { q: 'Is the code structure cleaner?', weight: 0.30 }
        ],
        logic_preservation: [
            { q: 'Does the refactored code preserve original behavior?', weight: 0.50 },
            { q: 'Are there any functional regressions?', weight: 0.50, invert: true }
        ],
        simplicity: [
            { q: 'Is complexity reduced?', weight: 0.50 },
            { q: 'Are abstractions appropriate and not over-engineered?', weight: 0.50 }
        ],
        correctness: [
            { q: 'Is the refactored code syntactically valid?', weight: 0.50 },
            { q: 'Are edge cases still handled?', weight: 0.50 }
        ]
    },
    dialogue: {
        relevance: [
            { q: 'Does the response address the previous turn?', weight: 0.50 },
            { q: 'Is irrelevant tangent avoided?', weight: 0.50 }
        ],
        naturalness: [
            { q: 'Does the response sound natural and conversational?', weight: 0.50 },
            { q: 'Is the tone appropriate for the context?', weight: 0.50 }
        ],
        helpfulness: [
            { q: 'Does the response move the conversation toward the user goal?', weight: 0.50 },
            { q: 'Is useful information or action provided?', weight: 0.50 }
        ],
        engagement: [
            { q: 'Does the response encourage further interaction?', weight: 0.50 },
            { q: 'Is the response interesting or thoughtful?', weight: 0.50 }
        ]
    },
    'multi-turn-reasoning': {
        context_retention: [
            { q: 'Does the response correctly use information from earlier steps or context?', weight: 0.40 },
            { q: 'Is context from earlier steps used accurately?', weight: 0.35 },
            { q: 'Does it avoid contradicting earlier established facts?', weight: 0.25 }
        ],
        logical_progression: [
            { q: 'Does the reasoning build logically on previous steps?', weight: 0.40 },
            { q: 'Are new conclusions consistent with prior reasoning?', weight: 0.35 },
            { q: 'Is the chain of thought traceable?', weight: 0.25 }
        ],
        accuracy: [
            { q: 'Is the final conclusion correct?', weight: 0.50 },
            { q: 'Are intermediate results accurate?', weight: 0.50 }
        ],
        coherence: [
            { q: 'Is the overall response coherent across all steps?', weight: 0.50 },
            { q: 'Does the response maintain a consistent position?', weight: 0.50 }
        ]
    },
    'context-retention': {
        recall_accuracy: [
            { q: 'Does the response correctly recall previously stated information?', weight: 0.40 },
            { q: 'Are specific details (names, numbers, facts) accurately recalled?', weight: 0.35 },
            { q: 'Is the recalled information attributed correctly?', weight: 0.25 }
        ],
        relevance_filtering: [
            { q: 'Does the response retrieve the most relevant context?', weight: 0.50 },
            { q: 'Is irrelevant context filtered out?', weight: 0.50 }
        ],
        consistency: [
            { q: 'Is the response consistent with earlier statements?', weight: 0.50 },
            { q: 'Are there any contradictions with prior context?', weight: 0.50, invert: true }
        ],
        no_hallucination: [
            { q: 'Does the response avoid inventing information not in the context?', weight: 0.60 },
            { q: 'Are claims grounded in the provided information?', weight: 0.40 }
        ]
    },
    'edge-cases': {
        error_handling: [
            { q: 'Does the response handle the unusual input gracefully?', weight: 0.40 },
            { q: 'Is an appropriate error or clarification provided?', weight: 0.35 },
            { q: 'Does it avoid crashing or producing garbage output?', weight: 0.25 }
        ],
        robustness: [
            { q: 'Does the response remain sensible under unusual conditions?', weight: 0.50 },
            { q: 'Does it degrade gracefully rather than fail completely?', weight: 0.50 }
        ],
        validation: [
            { q: 'Does the response identify invalid or problematic input?', weight: 0.50 },
            { q: 'Is the validation response appropriate and helpful?', weight: 0.50 }
        ],
        recovery: [
            { q: 'Does the response suggest a way forward despite the edge case?', weight: 0.50 },
            { q: 'Is helpful fallback behavior demonstrated?', weight: 0.50 }
        ]
    }
};

module.exports = { DECOMPOSED_QUESTIONS };
