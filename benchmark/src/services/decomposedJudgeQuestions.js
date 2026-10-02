'use strict';
/**
 * Decomposed Judge — Static Question Bank
 *
 * Pure data: category → dimension → [{ q, weight, conditional? }]
 * Extracted from decomposedJudge.js to keep service files within 600-line limit.
 *
 * Rubric contract (see docs/judge-rubric.md):
 * - Every question is positively keyed: YES always earns credit. Calibration
 *   showed that judges of every size answer "is anything wrong?" questions by
 *   overall impression rather than by their wording, which cost a response
 *   identical to its expected answer two points.
 * - A question that only applies when the task calls for it starts with "If"
 *   and carries `conditional: true`. The judge may answer NA to it, and an NA
 *   answer is excluded from the dimension's weight instead of counting as NO.
 * - Questions ask about what the task or the expected answer requires, never
 *   about properties the task did not request.
 * - A graded question (`graded: [{ answer, credit }]`) asks the judge to count
 *   rather than to say yes or no, so a correct-but-thin answer earns partial
 *   credit instead of all or nothing. The judge answers with one of the listed
 *   options; NA is never offered on a graded question.
 *
 * Consumed by: src/services/decomposedJudge.js
 */

// "How many are missing": 0 earns full credit, three or more earns none.
const MISSING_COUNT = Object.freeze([
    { answer: '0', credit: 1 },
    { answer: '1', credit: 0.66 },
    { answer: '2', credit: 0.33 },
    { answer: '3 or more', credit: 0 }
]);

const DECOMPOSED_QUESTIONS = {
    coding: {
        correctness: [
            { q: 'Does the response do what the task asks for?', weight: 0.20 },
            { q: 'Would the code produce correct output for the typical inputs of this task?', weight: 0.30 },
            { q: 'How many of the requirements stated in the task does the code fail to meet? Count them.', weight: 0.20, graded: MISSING_COUNT },
            { q: 'If the task describes a bug or a failing behavior, is that bug correctly identified and fixed?', weight: 0.15, conditional: true },
            { q: 'If the task modifies existing code, is the behavior that must be preserved still intact?', weight: 0.15, conditional: true }
        ],
        clarity: [
            { q: 'Is the code readable enough for a reviewer to verify it quickly, even with terse names?', weight: 0.40 },
            { q: 'Is the code organized into logical units rather than one long unstructured sequence?', weight: 0.30 },
            { q: 'Are the names and literals understandable in context?', weight: 0.30 }
        ],
        efficiency: [
            { q: 'Is the algorithmic complexity appropriate for the task as stated? Use the expected answer as the reference level when one is given.', weight: 0.50 },
            { q: 'Is the code free of obviously wasteful patterns, such as repeated work or unnecessary passes over the data?', weight: 0.30 },
            { q: 'Is the solution free of complexity the task did not call for?', weight: 0.20 }
        ],
        robustness: [
            { q: 'If the task asks for input validation, error handling or specific edge cases, does the code handle them?', weight: 0.50, conditional: true },
            { q: 'Does the code handle the boundary values implied by the task, such as the smallest or empty input, correctly?', weight: 0.30 },
            { q: 'Does the code avoid crashing or misbehaving on inputs the task says it must accept?', weight: 0.20 }
        ]
    },
    reasoning: {
        accuracy: [
            { q: 'Is the final conclusion or answer correct? Compare with the expected answer when one is given.', weight: 0.40 },
            { q: 'Are the intermediate facts, computations and uses of the given context correct?', weight: 0.35 },
            { q: 'Is the reasoning free of factual or interpretive errors?', weight: 0.25 }
        ],
        logic_soundness: [
            { q: 'Does each reasoning step follow from the previous one?', weight: 0.30 },
            { q: 'Is the reasoning free of contradictions and logical fallacies?', weight: 0.30 },
            { q: 'Does the response distinguish between what it knows and what it assumes?', weight: 0.20 },
            { q: 'If the question admits plausible alternative answers or counterarguments, does the response consider them?', weight: 0.20, conditional: true }
        ],
        completeness: [
            { q: 'Does the response address every part of the question or task?', weight: 0.25 },
            { q: 'Compared with the expected answer, how many of its key points are missing from the response? Count them.', weight: 0.30, graded: MISSING_COUNT },
            { q: 'If the task involves edge cases, failure modes or boundary conditions, are they considered?', weight: 0.20, conditional: true },
            { q: 'Is there enough detail to justify the conclusion?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Is the conclusion clearly stated and easy to locate in the response?', weight: 0.35 },
            { q: 'Are key assumptions or dependencies stated rather than left entirely implicit?', weight: 0.35 },
            { q: 'Does the response use at least one specific example, number or piece of evidence to support its reasoning?', weight: 0.30 }
        ]
    },
    math: {
        answer_correctness: [
            { q: 'Is the final answer correct? Compare with the expected answer when one is given.', weight: 0.50 },
            { q: 'Is the final answer consistent with the derivation shown?', weight: 0.25 },
            { q: 'If the task expects a specific answer format or units, does the answer use them?', weight: 0.25, conditional: true }
        ],
        method: [
            { q: 'Is the solution approach valid for this problem?', weight: 0.30 },
            { q: 'Are the right formulas or methods used?', weight: 0.25 },
            { q: 'Compared with the expected answer, how many of its essential steps are missing from the response? Count them.', weight: 0.20, graded: MISSING_COUNT },
            { q: 'Are the critical calculation steps shown and numerically consistent?', weight: 0.25 }
        ],
        rigor: [
            { q: 'Are the key steps mathematically valid and free of algebraic or arithmetic errors?', weight: 0.40 },
            { q: 'If the problem states constraints or boundary conditions, does the solution address them?', weight: 0.35, conditional: true },
            { q: 'Does the solution reach a final answer without leaving steps unfinished?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Does each major step clearly and correctly transform from the previous one?', weight: 0.40 },
            { q: 'Are variables defined before they are used in equations?', weight: 0.30 },
            { q: 'Is notation used correctly and consistently throughout?', weight: 0.30 }
        ]
    },
    knowledge: {
        accuracy: [
            { q: 'Are the stated facts, dates, names and numbers correct? Compare with the expected answer when one is given.', weight: 0.40 },
            { q: 'If the response makes claims about external facts beyond the direct answer, are those claims accurate?', weight: 0.20, conditional: true },
            { q: 'Does the response avoid common misconceptions and unsupported claims?', weight: 0.20 },
            { q: 'Are the claims grounded in established knowledge rather than fabricated?', weight: 0.20 }
        ],
        completeness: [
            { q: 'Does the response directly answer the question? For a specific factual question, a brief correct answer counts as a full answer; mark down only if the core answer is missing or wrong.', weight: 0.35 },
            { q: 'Compared with the expected answer, how many of the key facts the question asked for are missing from the response? Count them; do not count tangential information that was not requested.', weight: 0.40, graded: MISSING_COUNT },
            { q: 'Is the response appropriately scoped to the question, neither truncated below what is needed nor padded with irrelevant detail?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Is the main answer clearly stated rather than buried in tangential detail?', weight: 0.35 },
            { q: 'Does the response use specific facts or examples rather than vague generalities?', weight: 0.35 },
            { q: 'Is the response understandable to someone without deep domain expertise?', weight: 0.30 }
        ],
        objectivity: [
            { q: 'Is the response balanced and free of unsupported personal opinions presented as fact?', weight: 0.35 },
            { q: 'If the topic is genuinely uncertain or contested, is that uncertainty acknowledged? Confidently stating well-established facts is correct, not a flaw.', weight: 0.35, conditional: true },
            { q: 'Does the response avoid claiming confidence about things that are actually unknown?', weight: 0.30 }
        ]
    },
    instruction: {
        instruction_adherence: [
            { q: 'Does the response produce the exact type of output requested, such as a list, a paragraph, JSON or a single word?', weight: 0.35 },
            { q: 'Does the response address every distinct sub-task or requirement in the instruction?', weight: 0.30 },
            { q: 'If the task asks for summarization or transformation, are the key points of the source preserved without adding new information? Compare with the expected answer.', weight: 0.20, conditional: true },
            { q: 'If the task states explicit constraints, does the response satisfy them without speculative extras?', weight: 0.15, conditional: true }
        ],
        constraint_compliance: [
            { q: 'Does the response satisfy the measurable constraints of the task, such as count, length, ordering, language or tone?', weight: 0.40 },
            { q: 'Is the response free of content the task explicitly forbids?', weight: 0.35 },
            { q: 'Does the response stay within the requested output scope, without extra content?', weight: 0.25 }
        ],
        format_accuracy: [
            { q: 'Does the response use the same structural format as the expected answer?', weight: 0.50 },
            { q: 'If the task or expected answer specifies separators, delimiters or key names, does the response match them?', weight: 0.50, conditional: true }
        ],
        completeness: [
            { q: 'Does the response include all required fields or sections?', weight: 0.25 },
            { q: 'Compared with the expected answer, how many required output elements or key content points are missing from the response? Count them.', weight: 0.40, graded: MISSING_COUNT },
            { q: 'If the task is a transformation, are all mandatory content elements preserved?', weight: 0.20, conditional: true },
            { q: 'Is the response appropriately brief for the task and its constraints?', weight: 0.15 }
        ]
    },
    creative: {
        // Creative prompts include narrative AND dialog / clarifying-question forms.
        // Questions evaluate the response against the form the prompt actually requested,
        // so a well-formed dialog or Q&A reply is not penalized for lacking narrative structure.
        // Form is the primary dimension: a haiku that is not a haiku is not a
        // weak haiku, whatever its imagery; a valid but plain one is.
        form: [
            { q: 'How many of the constraints of the requested form does the piece violate, such as line or syllable counts, length, structure or required elements? Count them.', weight: 0.60, graded: MISSING_COUNT },
            { q: 'Is the piece in the requested genre and output shape, such as a story, a dialog, a poem or a list?', weight: 0.40 }
        ],
        originality: [
            { q: 'Does the response introduce at least one idea, angle or framing not directly stated in the prompt, including a fresh question, observation or perspective?', weight: 0.35 },
            { q: 'Does it avoid cliches, stock phrases and predictable devices for the requested form?', weight: 0.35 },
            { q: 'Would removing this response leave a gap that a generic template could not fill?', weight: 0.30 }
        ],
        coherence: [
            { q: 'Is the piece logically organized for the form the prompt requested, such as a narrative arc, a dialog exchange, a Q&A or another stated structure?', weight: 0.35 },
            { q: 'Is the piece free of contradictions, dangling threads and unexplained jumps?', weight: 0.35 },
            { q: 'Do transitions between ideas, lines or scenes feel earned rather than abrupt?', weight: 0.30 }
        ],
        engagement: [
            { q: 'Does the opening line, sentence, question or exchange establish a clear tone or hook the reader?', weight: 0.35 },
            { q: 'Does the writing use concrete specifics, such as sensory detail, dialogue, examples or pointed questions, rather than vague abstractions?', weight: 0.35 },
            { q: 'Does the piece build toward a payoff, insight, emotional beat or useful resolution appropriate to the requested form?', weight: 0.30 }
        ],
        relevance: [
            { q: 'Does it address the specific scenario, constraints or characters described in the prompt?', weight: 0.60 },
            { q: 'Does it keep the tone the prompt asked for, or a fitting one when none was asked for?', weight: 0.40 }
        ]
    },
    translation: {
        accuracy: [
            { q: 'Is the meaning of the original text preserved?', weight: 0.35 },
            { q: 'How many words or phrases of the original are mistranslated or omitted in the translation? Count them.', weight: 0.40, graded: MISSING_COUNT },
            { q: 'If the text contains numbers, names or technical terms, are they handled correctly?', weight: 0.25, conditional: true }
        ],
        fluency: [
            { q: 'Does the translation read naturally in the target language?', weight: 0.50 },
            { q: 'Is the sentence structure appropriate for the target language?', weight: 0.50 }
        ],
        grammar: [
            { q: 'Is the grammar correct in the target language?', weight: 0.50 },
            { q: 'Are punctuation and capitalization appropriate?', weight: 0.50 }
        ],
        cultural_fit: [
            { q: 'If the text contains idioms or expressions, are they adapted appropriately?', weight: 0.50, conditional: true },
            { q: 'Is the tone suitable for the target audience?', weight: 0.50 }
        ]
    },
    agent: {
        finding_accuracy: [
            { q: 'Does the response reach the conclusion the expected answer gives?', weight: 0.35 },
            { q: 'How many of the problems, errors or items the expected answer lists does the response miss? Count them.', weight: 0.40, graded: MISSING_COUNT },
            { q: 'If the task asks for a classification or a priority order, is it the one the expected answer gives?', weight: 0.25, conditional: true }
        ],
        actionability: [
            { q: 'Does the response give a next action someone could carry out as written?', weight: 0.50 },
            { q: 'Is the recommended action safe, without a destructive step the evidence does not justify?', weight: 0.50 }
        ],
        grounding: [
            { q: 'Is every finding supported by the text, data or logs the task provides?', weight: 0.60 },
            { q: 'Does the response stay free of problems or facts that the task does not contain?', weight: 0.40 }
        ],
        format_compliance: [
            { q: 'Does the output follow the format the task requests?', weight: 0.60 },
            { q: 'If the task limits length or asks for a specific language, is that limit or language respected?', weight: 0.40, conditional: true }
        ]
    }
};

module.exports = { DECOMPOSED_QUESTIONS, MISSING_COUNT };
