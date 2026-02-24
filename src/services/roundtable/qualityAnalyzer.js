/**
 * Roundtable Quality Analyzer
 * Scores agent responses using LLM-as-Judge pattern.
 * Reuses callJudge + extractBalancedJson from scoring/judgeCall.js
 */

const logger = require('../../../config/logger');
const { callJudge, buildDynamicJudgePrompt } = require('../scoring/judgeCall');
const { getTargetForModel } = require('../modelRouter');
const Roundtable = require('../../../models/Roundtable');

// Scoring dimensions for agent turns
const AGENT_DIMENSIONS = [
  { name: 'clarity', desc: 'How clear, well-structured, and easy to follow is the response?' },
  { name: 'evidence_quality', desc: 'How well does the agent support claims with reasoning, examples, or evidence?' },
  { name: 'logical_coherence', desc: 'How logically consistent and well-reasoned is the argument?' }
];

// Scoring dimensions for synthesis
const SYNTHESIS_DIMENSIONS = [
  { name: 'coverage', desc: 'How well does the synthesis cover all agent perspectives and key points?' },
  { name: 'fairness', desc: 'How fairly does the synthesis represent different viewpoints without bias?' },
  { name: 'actionability', desc: 'How actionable and useful is the final verdict/recommendation?' }
];

/**
 * Analyze quality of a completed roundtable discussion
 * @param {string} roundtableId - Roundtable document ID
 * @param {Object} [judgeConfig] - Override judge model config
 * @returns {Object} qualityScores object
 */
async function analyzeQuality(roundtableId, judgeConfig = {}) {
  const doc = await Roundtable.findById(roundtableId);
  if (!doc || doc.status !== 'completed') {
    logger.warn('Quality analysis skipped — roundtable not completed', { roundtableId });
    return null;
  }

  const turns = doc.turns || [];
  if (turns.length === 0) {
    logger.warn('Quality analysis skipped — no turns', { roundtableId });
    return null;
  }

  logger.info('Starting quality analysis', { roundtableId, turnsCount: turns.length });

  const agentScores = {};
  const errors = [];

  // Score each agent's turns (use last round's response for final quality)
  const agentIds = [...new Set(turns.map(t => t.agentId))];
  const maxRound = Math.max(...turns.map(t => t.round));

  for (const agentId of agentIds) {
    // Use the last round response as the most refined version
    const turn = turns.filter(t => t.agentId === agentId).sort((a, b) => b.round - a.round)[0];
    if (!turn || !turn.response || turn.error) {
      agentScores[agentId] = { clarity: 0, evidence_quality: 0, logical_coherence: 0, overall: 0, error: turn?.error || 'No response' };
      continue;
    }

    const prompt = buildDynamicJudgePrompt(
      AGENT_DIMENSIONS,
      `Evaluate this roundtable agent response (${turn.role}) to the question: "${doc.question}"`,
      'A well-reasoned, clear, evidence-based analysis from the agent\'s perspective',
      turn.response
    );

    const result = await callJudge(prompt, judgeConfig);

    if (result.success && result.scores) {
      agentScores[agentId] = {
        clarity: result.scores.clarity ?? null,
        evidence_quality: result.scores.evidence_quality ?? null,
        logical_coherence: result.scores.logical_coherence ?? null,
        overall: result.scores.overall ?? null,
        role: turn.role,
        round: turn.round
      };
    } else {
      agentScores[agentId] = { clarity: 0, evidence_quality: 0, logical_coherence: 0, overall: 0, error: result.error };
      errors.push({ agentId, error: result.error });
    }
  }

  // Score synthesis
  let synthesisScores = null;
  if (doc.synthesis?.response) {
    const synthPrompt = buildDynamicJudgePrompt(
      SYNTHESIS_DIMENSIONS,
      `Evaluate this roundtable synthesis for the question: "${doc.question}"`,
      'A comprehensive, fair, and actionable synthesis of multiple agent perspectives',
      doc.synthesis.response
    );

    const synthResult = await callJudge(synthPrompt, judgeConfig);

    if (synthResult.success && synthResult.scores) {
      synthesisScores = {
        coverage: synthResult.scores.coverage ?? null,
        fairness: synthResult.scores.fairness ?? null,
        actionability: synthResult.scores.actionability ?? null,
        overall: synthResult.scores.overall ?? null
      };
    } else {
      synthesisScores = { coverage: 0, fairness: 0, actionability: 0, overall: 0, error: synthResult.error };
      errors.push({ agentId: 'synthesizer', error: synthResult.error });
    }
  }

  // Compute agreement index: how much agent scores converge
  const overallScores = Object.values(agentScores)
    .map(s => s.overall)
    .filter(s => typeof s === 'number' && s > 0);

  let agreementIndex = null;
  if (overallScores.length >= 2) {
    const mean = overallScores.reduce((a, b) => a + b, 0) / overallScores.length;
    const variance = overallScores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / overallScores.length;
    // Agreement: 1 - normalized std deviation (0=total disagreement, 1=perfect agreement)
    agreementIndex = Math.max(0, 1 - Math.sqrt(variance) / 10);
  }

  const qualityScores = {
    agents: agentScores,
    synthesis: synthesisScores,
    agreementIndex,
    analyzedAt: new Date(),
    errors: errors.length > 0 ? errors : undefined
  };

  // Persist to Roundtable document
  await Roundtable.updateOne(
    { _id: roundtableId },
    { $set: { qualityScores } }
  );

  logger.info('Quality analysis completed', {
    roundtableId,
    agentCount: Object.keys(agentScores).length,
    synthesisScored: !!synthesisScores,
    agreementIndex,
    errorCount: errors.length
  });

  return qualityScores;
}

module.exports = { analyzeQuality, AGENT_DIMENSIONS, SYNTHESIS_DIMENSIONS };
