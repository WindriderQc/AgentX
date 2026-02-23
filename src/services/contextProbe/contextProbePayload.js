/**
 * Context Probe Payload Generator
 *
 * Generates deterministic fill prompts that consume a target number of tokens.
 * Used by the context probe service to fill context windows during binary search.
 */

// ~100 tokens of repeatable prose (measured against Ollama tokenizers)
const FILL_BLOCK = [
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'Mountains rise above the valley where ancient forests grow tall.',
  'Scientists discovered a new species of butterfly in the rainforest.',
  'The old clocktower chimed twelve times as the crowd gathered below.',
  'Waves crashed against the rocky shoreline under a gray autumn sky.',
  'A small village at the edge of the desert thrived on trade routes.',
  'Engineers designed a bridge that could withstand powerful earthquakes.',
  'The library contained thousands of manuscripts from the medieval era.'
].join(' ');

// Approximate tokens in FILL_BLOCK (conservative: 1 token ≈ 4 chars)
const BLOCK_TOKENS = Math.ceil(FILL_BLOCK.length / 4);

/**
 * Generate a prompt that fills approximately `targetTokens` tokens.
 * Leaves room for a short completion instruction.
 *
 * @param {number} targetTokens - Desired prompt token count
 * @returns {{ prompt: string, estimatedTokens: number }}
 */
function generateFillPrompt(targetTokens) {
  if (!targetTokens || targetTokens < 100) {
    return { prompt: FILL_BLOCK, estimatedTokens: BLOCK_TOKENS };
  }

  // Reserve a small footer for the completion instruction
  const footerTokens = 30;
  const fillTarget = targetTokens - footerTokens;
  const repetitions = Math.max(1, Math.ceil(fillTarget / BLOCK_TOKENS));

  const parts = [];
  for (let i = 0; i < repetitions; i++) {
    parts.push(FILL_BLOCK);
  }

  const footer = '\n\nBased on the text above, respond with exactly one word: OK';
  const prompt = parts.join('\n') + footer;
  const estimatedTokens = Math.ceil(prompt.length / 4);

  return { prompt, estimatedTokens };
}

module.exports = { generateFillPrompt, FILL_BLOCK, BLOCK_TOKENS };
