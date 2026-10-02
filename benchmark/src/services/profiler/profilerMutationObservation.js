'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const responses = new WeakMap();
const jsonTimings = new WeakMap();

async function beginResponseMutation(operation) {
  const journal = context.getStore();
  if (!journal) return operation();
  const ticket = await journal.beforeMutation();
  try {
    const dispatchedAt = Date.now();
    const response = await operation();
    responses.set(response, { journal, ticket, dispatchedAt });
    return response;
  } catch (error) {
    await journal.unknownMutation(ticket, error);
    throw error;
  }
}
async function completeResponseMutation(response) {
  const observation = responses.get(response);
  if (!observation) return;
  await observation.journal.completeMutation(observation.ticket);
  responses.delete(response);
}
// Ollama answering 4xx rejected the request before any runtime work (for
// example a model without thinking support). The request is over: record a
// terminal receipt instead of an unknown outcome, which would refuse every
// later request and quarantine the host.
function rejectedBeforeWork(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

async function observeJsonMutation(operation) {
  const journal = context.getStore();
  if (!journal) return operation();
  const ticket = await journal.beforeMutation();
  try {
    const dispatchedAt = Date.now();
    const result = await operation();
    const durationMs = Date.now() - dispatchedAt;
    if (result && typeof result === 'object') jsonTimings.set(result, durationMs);
    await journal.completeMutation(ticket);
    return result;
  } catch (error) {
    if (rejectedBeforeWork(error)) await journal.completeMutation(ticket);
    else await journal.unknownMutation(ticket, error);
    throw error;
  }
}
module.exports = { rejectedBeforeWork, withMutationJournal: (journal, operation) => context.run(journal, operation),
  mutationDispatchAt: response => responses.get(response)?.dispatchedAt,
  jsonMutationDuration: (result, fallback) => jsonTimings.get(result) ?? fallback,
  beginResponseMutation, completeResponseMutation, observeJsonMutation };
