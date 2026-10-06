'use strict';

const count = value => Number.isSafeInteger(value) && value >= 0;
const usd = value => Number.isFinite(value) && value >= 0;

// Native turns carry execution evidence. Estimating them again from transcript
// characters and a legacy model price would invent a second measurement.
function recordedConversationUsage(conversation) {
  const messages = Array.from(conversation.messages || []);
  const turns = messages.filter(message => message.metadata?.executionReceipt || message.role === 'assistant');
  let promptTokens = 0, completionTokens = 0, cost = 0;
  let tokensKnown = turns.length > 0 || messages.length === 0;
  let costKnown = tokensKnown;
  for (const message of turns) {
    const receipt = message.metadata?.executionReceipt;
    const usage = receipt?.usage;
    const input = usage?.input != null
      ? usage.input + (usage.cacheRead || 0) + (usage.cacheWrite || 0)
      : usage?.input_tokens ?? message.stats?.usage?.promptTokens;
    const output = usage?.output ?? usage?.output_tokens ?? message.stats?.usage?.completionTokens;
    if (count(input) && count(output)) { promptTokens += input; completionTokens += output; }
    else tokensKnown = false;
    const value = receipt ? (usd(receipt.cost?.nanodollars) && receipt.cost.currency === 'USD' ? receipt.cost.nanodollars / 1e9 : null)
      : (message.cost?.currency === 'USD' ? message.cost.totalCost : null);
    if (usd(value)) cost += value;
    else costKnown = false;
  }
  return { model: conversation.model, promptTokens: tokensKnown ? promptTokens : null,
    completionTokens: tokensKnown ? completionTokens : null,
    totalTokens: tokensKnown ? promptTokens + completionTokens : null, cost: costKnown ? cost : null };
}
module.exports = { recordedConversationUsage };
