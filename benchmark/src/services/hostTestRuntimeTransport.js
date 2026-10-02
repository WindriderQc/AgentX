'use strict';
const { readBoundedJson } = require('../../../shared/outboundHttpExecutor');
const { beginResponseMutation, completeResponseMutation, mutationDispatchAt, rejectedBeforeWork } = require('./profiler/profilerMutationObservation');
function createHostTestRequest({ assertRegisteredOperation, hostTestExecutor }) {
  async function hostTestRequest(operationId, target, options = {}, executor = hostTestExecutor) {
    let requested;
    try {
      requested = new URL(target);
    } catch {
      throw new Error('Host test outbound target is not registered');
    }
    const method = String(options.method || 'GET').toUpperCase();
    assertRegisteredOperation(operationId, method, requested);
    const receipt = await executor.admitTarget(operationId, requested.href, {
      signal: options.signal
    });
    const dispatch = () => executor.request(receipt, { ...options, method });
    return method === 'POST' ? beginResponseMutation(dispatch) : dispatch();
  }

  return hostTestRequest;
}
async function readExactGenerateTerminal(response, action) {
  if (!response.ok) {
    await response.cancel();
    const error = new Error(`Ollama ${action} returned HTTP ${response.status}`);
    error.code = 'OLLAMA_GENERATE_REJECTED';
    error.status = response.status;
    if (rejectedBeforeWork(error)) await completeResponseMutation(response);
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
}

async function readOllamaGenerateStream(response, startedAt, now = Date.now) {
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

module.exports = { createHostTestRequest, readExactGenerateTerminal, readOllamaGenerateStream };
