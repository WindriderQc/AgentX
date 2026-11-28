'use strict';

const TOOL = Object.freeze({
  name: 'family_kitchen_timer',
  description: 'Operate the shared kitchen timer only when the current speaker requests it, interpreting the active dialogue. Start, check, cancel or add time to the running timer. For a follow-up asking how much time is left on that timer, call action=status even if the timer is not named. Never estimate remaining time from an earlier reply, original duration, or conversation time. Use the latest subject; a follow-up about another countdown is not about this timer. Do not call for a quote, a hypothetical, a negated instruction, or a question about another subject. Use whole seconds for start and extend only. Do not speak an action confirmation before Core supplies the result.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: { action: { enum: ['start', 'status', 'cancel', 'extend'] }, seconds: { type: 'integer', minimum: 1, maximum: 86400 } },
    oneOf: [{ properties: { action: { enum: ['start', 'extend'] } }, required: ['seconds'] },
      { properties: { action: { enum: ['status', 'cancel'] } }, not: { required: ['seconds'] } }]
  }
});

// This is evidence about the previous exchange, never a current reading.
function previousTimerReceipt(turn) {
  const receipt = turn?.toolEvidence?.receipts?.some(row => row.tool === TOOL.name && row.status === 'completed');
  return receipt ? 'Verified Core context: the immediately preceding exchange used the kitchen timer. If the current speaker follows up about how much time is left, call family_kitchen_timer with action=status before answering; the earlier duration is not the current countdown. If the speaker changes the subject, follow the new subject instead.' : '';
}

async function callTool(args, binding) {
  if (!binding) return { isError: true, structuredContent: { error: 'TIMER_UNAVAILABLE' } };
  const { service, requestId, language, signal } = binding;
  const fallback = language === 'en' ? 'I could not verify the kitchen timer.' : "Je n'ai pas pu vérifier la minuterie.";
  try {
    const result = await service.perform(args, { requestId, language, signal });
    return { isError: ['invalid', 'unavailable'].includes(result.outcome), structuredContent: result };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { isError: true, structuredContent: { error: 'TIMER_UNAVAILABLE', text: fallback } };
  }
}

module.exports = { TOOL, callTool, previousTimerReceipt };
