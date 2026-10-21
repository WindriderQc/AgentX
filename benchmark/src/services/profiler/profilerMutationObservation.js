'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const responses = new WeakMap();
const jsonTimings = new WeakMap();

// A streamed request. With `request` ({ model, numCtx, timeoutMs }, as for
// observeJsonMutation) the run owns its deadline and stop proof: the operation
// receives the journal's request control ({ signal, timeoutMs }) and must
// throw that signal's reason when it aborted.
async function beginResponseMutation(operation, request = null) {
  const journal = context.getStore();
  if (!journal) return operation(null);
  const ticket = await journal.beforeMutation(request && { ...request, abortable: true });
  try {
    const dispatchedAt = Date.now();
    const response = await operation(request ? journal.requestControl?.(ticket) ?? null : null);
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
// The response failed after dispatch (stream cut, deadline abort, error
// status): settle its ticket like a failed dispatch instead of leaving it
// pending, which refused every later request without saying why.
async function failResponseMutation(response, error) {
  const observation = responses.get(response);
  if (!observation) return;
  responses.delete(response);
  if (rejectedBeforeWork(error)) await observation.journal.completeMutation(observation.ticket);
  else await observation.journal.unknownMutation(observation.ticket, error);
}
// Ollama answering 4xx rejected the request before any runtime work (for
// example a model without thinking support). The request is over: record a
// terminal receipt instead of an unknown outcome, which would refuse every
// later request and quarantine the host.
function rejectedBeforeWork(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

// `request` describes a direct Ollama JSON request ({ model, numCtx, timeoutMs }),
// which an operator cancel or its expired deadline may abort and then prove
// stopped (see profileCancellation). The operation receives the journal's
// request control ({ signal, timeoutMs }) when the run owns that deadline.
async function observeJsonMutation(operation, request = null) {
  const journal = context.getStore();
  if (!journal) return operation(null);
  const ticket = await journal.beforeMutation(request && { ...request, abortable: true });
  try {
    const dispatchedAt = Date.now();
    const result = await operation(journal.requestControl?.(ticket) ?? null);
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
  // True inside a journaled run, which owns the deadline of an abortable request.
  mutationJournalActive: () => Boolean(context.getStore()),
  beginResponseMutation, completeResponseMutation, failResponseMutation, observeJsonMutation };
