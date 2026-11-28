'use strict';

const TOOL = Object.freeze({
  name: 'family_kitchen_timer',
  description: 'Operate the shared kitchen timer only when the current speaker requests it, interpreting the active dialogue. Start, check, cancel or add time to the running timer. An ambiguous follow-up may refer to the subject on screen, not the timer. Do not call for a quote, a hypothetical, a negated instruction, or a question about another subject. Use whole seconds for start and extend only. Do not speak an action confirmation before Core supplies the result.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: { action: { enum: ['start', 'status', 'cancel', 'extend'] }, seconds: { type: 'integer', minimum: 1, maximum: 86400 } },
    oneOf: [{ properties: { action: { enum: ['start', 'extend'] } }, required: ['seconds'] },
      { properties: { action: { enum: ['status', 'cancel'] } }, not: { required: ['seconds'] } }]
  }
});

async function callTool(args, binding) {
  if (!binding) return { isError: true, structuredContent: { error: 'TIMER_UNAVAILABLE' } };
  const { service, requestId, language, signal } = binding;
  const fallback = language === 'en' ? 'I could not verify the kitchen timer.' : "Je n'ai pas pu vérifier la minuterie.";
  try {
    const result = await service.perform(args, { requestId, language, signal });
    return { isError: result.outcome === 'invalid', structuredContent: result };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { isError: true, structuredContent: { error: 'TIMER_UNAVAILABLE', text: fallback } };
  }
}

module.exports = { TOOL, callTool };
