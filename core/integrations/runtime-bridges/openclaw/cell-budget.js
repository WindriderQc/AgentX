'use strict';

const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

// #897: a benchmark claim on this bridge belongs to a local native agent
// cell. Core reserves the call against the cell budget before dispatch; a
// refusal is raised here, before any host is contacted.
function admitCellCall(runtimeServices, claims, request, mode) {
  const budgets = runtimeServices.benchmarkCellBudgets;
  if (!budgets) {
    const error = new Error('Cell budgets are unavailable in this Core');
    error.code = 'BENCHMARK_CELL_BUDGET_UNAVAILABLE';
    error.statusCode = 409;
    throw error;
  }
  if (mode === 'embed') {
    budgets.admitEmbed(claims);
    return null;
  }
  const turn = budgets.reserve(claims, {
    system: request.system, prompt: request.prompt, messages: request.messages, tools: request.tools,
    numPredict: request.options?.num_predict
  });
  request.options = { ...request.options, num_predict: turn.numPredict };
  return turn;
}

function isCellBudgetRefusal(error) {
  return /^BENCHMARK_CELL_BUDGET_[A-Z_]+$/.test(String(error?.code || ''));
}

function responseCounts(body) {
  return {
    complete: body?.done !== false,
    inputTokens: body?.prompt_eval_count,
    outputTokens: body?.eval_count,
    toolCalls: Array.isArray(body?.message?.tool_calls) ? body.message.tool_calls.length : 0
  };
}

// Count tool calls as they stream and settle the turn from the terminal
// frame's counts before OpenClaw can see done:true and start its next call.
// A stream that closes without a terminal frame keeps its full reservation.
function meteredStream(source, turn) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let toolCalls = 0;
  const consume = function (text, final = false) {
    pending += text;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1 || (final && pending)) {
      const end = newline === -1 ? pending.length : newline + 1;
      const frame = pending.slice(0, end);
      pending = pending.slice(end);
      let parsed = null;
      try { parsed = JSON.parse(frame); } catch { /* Core validates frames. */ }
      if (Array.isArray(parsed?.message?.tool_calls)) toolCalls += parsed.message.tool_calls.length;
      if (parsed?.done === true) {
        turn.settle({ complete: true, inputTokens: parsed.prompt_eval_count, outputTokens: parsed.eval_count, toolCalls });
      }
      this.push(frame);
    }
  };
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      consume.call(this, decoder.write(chunk));
      callback();
    },
    flush(callback) {
      consume.call(this, decoder.end(), true);
      callback();
    }
  });
  source.once('error', error => meter.destroy(error));
  meter.once('close', () => {
    turn.settle({ complete: false, toolCalls });
    if (!source.readableEnded) source.resume();
  });
  source.pipe(meter);
  return meter;
}

module.exports = { admitCellCall, isCellBudgetRefusal, meteredStream, responseCounts };
