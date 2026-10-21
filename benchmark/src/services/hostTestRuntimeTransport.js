'use strict';
const { readBoundedJson } = require('../../../shared/outboundHttpExecutor');
const { beginResponseMutation, completeResponseMutation, failResponseMutation, mutationDispatchAt } = require('./profiler/profilerMutationObservation');
const requestSignals = new WeakMap();

// The structured reason of an aborted request (a run deadline or an operator
// cancel) replaces the executor's generic caller-abort error, so the run
// journal can take its stop proof. A plain local timer has no string code.
function abortReason(signal) {
  const reason = signal?.aborted ? signal.reason : null;
  return reason instanceof Error && typeof reason.code === 'string' ? reason : null;
}

function withControl(signal, control) {
  if (!control?.signal) return signal;
  return signal ? AbortSignal.any([signal, control.signal]) : control.signal;
}

function createHostTestRequest({ assertRegisteredOperation, hostTestExecutor }) {
  // `options.runtimeRequest` ({ model, numCtx, timeoutMs }) marks a direct
  // Ollama generate whose deadline a journaled run owns, as for ollamaClient.
  async function hostTestRequest(operationId, target, options = {}, executor = hostTestExecutor) {
    let requested;
    try {
      requested = new URL(target);
    } catch {
      throw new Error('Host test outbound target is not registered');
    }
    const { runtimeRequest = null, ...requestOptions } = options;
    const method = String(requestOptions.method || 'GET').toUpperCase();
    assertRegisteredOperation(operationId, method, requested);
    const receipt = await executor.admitTarget(operationId, requested.href, {
      signal: requestOptions.signal
    });
    const dispatch = async (control = null) => {
      const signal = withControl(requestOptions.signal, control);
      try {
        const response = await executor.request(receipt, { ...requestOptions, method, signal });
        if (response && typeof response === 'object') requestSignals.set(response, signal);
        return response;
      } catch (error) {
        throw abortReason(signal) || error;
      }
    };
    return method === 'POST' ? beginResponseMutation(dispatch, runtimeRequest) : dispatch();
  }

  return hostTestRequest;
}

// A response that failed after dispatch settles its journal ticket (see
// failResponseMutation) with the abort reason when its request was aborted.
async function failResponse(response, error) {
  const outcome = abortReason(requestSignals.get(response)) || error;
  await failResponseMutation(response, outcome);
  return outcome;
}
// A 4xx rejection is terminal (rejectedBeforeWork); any other failure leaves
// the request UNKNOWN in a journaled run.
async function readExactGenerateTerminal(response, action) {
  try {
    if (!response.ok) {
      await response.cancel();
      const error = new Error(`Ollama ${action} returned HTTP ${response.status}`);
      error.code = 'OLLAMA_GENERATE_REJECTED';
      error.status = response.status;
      throw error;
    }
    const terminal = await readBoundedJson(response);
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)
      || terminal.done !== true || typeof terminal.error === 'string') {
      const error = new Error(`Ollama ${action} ended without an exact terminal done object`);
      error.code = 'OLLAMA_RESPONSE_INCOMPLETE';
      throw error;
    }
    await completeResponseMutation(response);
    return terminal;
  } catch (error) {
    throw await failResponse(response, error);
  }
}

async function readOllamaGenerateStream(response, startedAt, now = Date.now) {
  try {
    return await readGenerateStream(response, startedAt, now);
  } catch (error) {
    throw await failResponse(response, error);
  }
}

async function readGenerateStream(response, startedAt, now) {
  startedAt = mutationDispatchAt(response) ?? startedAt;
  let buffer = '';
  let terminal = null;
  let output = '';
  let timeToFirstTokenMs = null;

  const consumeLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      const error = new Error('Ollama stream emitted a non-object frame');
      error.code = 'OLLAMA_STREAM_INVALID_FRAME';
      throw error;
    }
    if (terminal) {
      const error = new Error('Ollama stream emitted data after its terminal frame');
      error.code = 'OLLAMA_STREAM_POST_TERMINAL_DATA';
      throw error;
    }
    if (typeof event.error === 'string') {
      const error = new Error('Ollama stream emitted an error frame');
      error.code = 'OLLAMA_STREAM_ERROR';
      throw error;
    }
    if (event.done !== false && event.done !== true) {
      const error = new Error('Ollama stream frame omitted its explicit done state');
      error.code = 'OLLAMA_STREAM_INVALID_FRAME';
      throw error;
    }
    if (typeof event.response === 'string' && event.response.length > 0) {
      if (timeToFirstTokenMs === null) timeToFirstTokenMs = Math.max(0, now() - startedAt);
      output += event.response;
    }
    if (event.done === true) terminal = event;
  };

  for await (const chunk of response.stream()) {
    buffer += Buffer.from(chunk).toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer.trim()) consumeLine(buffer);
  if (!terminal) {
    const error = new Error('Ollama stream ended without a terminal metrics event');
    error.code = 'OLLAMA_STREAM_INCOMPLETE';
    throw error;
  }
  const clientDurationMs = now() - startedAt;
  await completeResponseMutation(response);
  return { data: { ...terminal, response: output }, timeToFirstTokenMs, clientDurationMs };
}

module.exports = { createHostTestRequest, failResponse, readExactGenerateTerminal, readOllamaGenerateStream };
