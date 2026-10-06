'use strict';

// Independently authored verdicts for the nine disagreements of #463. These
// are synthetic rubric interpretations, not human-approved gold grades and
// not answers obtained from the model being calibrated. Arrays follow each
// named dimension's question order; NA applies only to conditional questions.
module.exports = {
  'cal-med-02': {
    expectedScore: 6,
    dimensions: { clarity: [true, true, true], efficiency: [false, false, true], robustness: ['NA', true, true] },
    criteria: [true, true, false],
    rationale: 'The executable prime checks pass. Linear trial division loses complexity and repeated-work credit, while the implementation is simple.'
  },
  'cal-med-04': {
    expectedScore: 6.3,
    dimensions: {
      instruction_adherence: [true, false, false, true], constraint_compliance: [true, true, true],
      format_accuracy: [true, 'NA'], completeness: [true, '2', false, true]
    },
    criteria: [true, true, true, false],
    rationale: 'The single required sentence is present, but self-improvement and lack of explicit programming are missing. Output structure is evaluated independently of content.'
  },
  'cal-med-05': {
    expectedScore: 4,
    dimensions: { form: ['0', true], originality: [false, false, false], coherence: [true, true, false],
      engagement: [false, true, false], relevance: [true, true] },
    criteria: [true, true, false],
    rationale: 'The lines have 5, 7 and 5 syllables. Blue, fish and waves are concrete specifics, but generic imagery provides neither originality nor a payoff.'
  },
  'cal-exc-05': {
    expectedScore: 10,
    dimensions: { form: ['0', true], originality: [true, true, true], coherence: [true, true, true],
      engagement: [true, true, true], relevance: [true, true] },
    criteria: [true, true, true],
    rationale: 'The independently checked 5-7-5 poem supplies a coherent moonlit ocean scene and sensory details; creative taste remains subjective.'
  },
  'cal-tr-02': {
    expectedScore: 7.5,
    criteria: [true, false, true, true], similarity: 'GOOD', contradictions: false,
    rationale: 'The French request and Monday meeting are preserved; the Friday deadline is omitted. Omission is distinct from contradiction, and most information is present.'
  },
  'cal-tr-05': {
    expectedScore: 6.1,
    dimensions: { accuracy: [false, '1', true], fluency: [true, true], grammar: [true, true], cultural_fit: ['NA', true] },
    criteria: [true, false, true, true],
    rationale: 'The Sunday qualifier is one omitted phrase. Nine and noon, grammar and fluency remain correct; the target language is Spanish.'
  },
  'cal-ag-02': {
    expectedScore: 6.5,
    dimensions: { finding_accuracy: [true, '1', 'NA'], actionability: [true, true], grounding: [false, false],
      format_compliance: [true, true] },
    criteria: [true, true, false, false, false],
    rationale: 'The full destination and cited error are correct; retention is missing and unstable networking is invented. Generic freeing of space does not establish the specifically requested retention fix.'
  },
  'cal-ag-05': {
    expectedScore: 4.5,
    dimensions: { finding_accuracy: [false, '1', 'NA'], actionability: [true, true], grounding: [false, false],
      format_compliance: [true, 'NA'] },
    criteria: [true, false, false, false],
    rationale: 'The dump-hour finding and its correction are valid. One planted finding (Monday cleanup) is missed and a sync problem is invented. The combined correction criterion is only partly satisfied.'
  },
  'cal-kn-02': {
    expectedScore: 5,
    criteria: [false, false, true, true], similarity: 'PARTIAL', contradictions: false,
    rationale: 'Connection orientation and ordering are absent; faster UDP and two sentences earn credit. The true but thin answer has significant gaps without a contradiction.'
  }
};
