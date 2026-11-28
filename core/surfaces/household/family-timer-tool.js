'use strict';

const TOOL = Object.freeze({
  name: 'family_kitchen_timer',
  description: 'Operate the shared kitchen timer only when the current speaker requests it, interpreting the active dialogue. Start, check, cancel or add time to the running timer. For remaining time, call action=status only for an explicit kitchen timer reference or a clear follow-up to the immediately preceding kitchen-timer exchange. A running timer or older timer turn is not enough. Never estimate remaining time from an earlier reply, original duration, or conversation time. Use the latest subject; a follow-up about another countdown is not about this timer. Do not call for a quote, a hypothetical, a negated instruction, or a question about another subject. Use whole seconds for start and extend only. Do not speak an action confirmation before Core supplies the result.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: { action: { enum: ['start', 'status', 'cancel', 'extend'] }, seconds: { type: 'integer', minimum: 1, maximum: 86400 } },
    oneOf: [{ properties: { action: { enum: ['start', 'extend'] } }, required: ['seconds'] },
      { properties: { action: { enum: ['status', 'cancel'] } }, not: { required: ['seconds'] } }]
  }
});

// This is evidence about the previous exchange, never a current reading.
function previousTimerReceipt(turn) {
  if (!turn) return '';
  const receipt = turn?.toolEvidence?.receipts?.some(row => row.tool === TOOL.name && row.status === 'completed');
  return receipt
    ? 'Verified Core context: the immediately preceding exchange used the kitchen timer. If the current speaker follows up about how much time is left on it, call family_kitchen_timer with action=status before answering. If they change the subject, follow the new subject instead.'
    : 'Verified Core context: the immediately preceding exchange did not use the kitchen timer. If the current speaker clearly asks for the kitchen timer, call family_kitchen_timer even if the last subject was different or you just asked them to clarify. Otherwise for a short follow-up about time remaining, stay on the current subject or clarify. An earlier timer mention by itself does not warrant a read.';
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
