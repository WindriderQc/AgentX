'use strict';

// OpenAI Responses API front-end over the gateway's chat path. Requests are
// stateless (`store: false`, full history in `input`), which is what Codex
// sends, so Core keeps no response store. Function tools, tools grouped in a
// `namespace` and freeform `custom` tools are offered to the model as plain
// functions; hosted tools (web search, file search…) have no local executor
// and are not offered.
const { randomUUID } = require('crypto');
const { Transform } = require('stream');
const { isImagePart } = require('./messages');

const NAMESPACE_SEPARATOR = '__';
const FILE_OMITTED = '[file omitted: the AgentX gateway sends text and images only]';
const IGNORED_INPUT_ITEMS = new Set(['reasoning', 'item_reference', 'web_search_call', 'file_search_call', 'compaction']);

function invalidRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'RESPONSES_REQUEST_INVALID' });
}

function partText(part) {
  if (typeof part === 'string') return part;
  if (['input_text', 'output_text', 'text', 'summary_text', 'refusal'].includes(part?.type)) return String(part.text ?? part.refusal ?? '');
  if (part?.type === 'input_file') return FILE_OMITTED;
  return '';
}

function contentText(content) {
  if (content == null) return '';
  if (!Array.isArray(content)) return typeof content === 'string' ? content : partText(content);
  return content.map(partText).filter(Boolean).join('\n');
}

// Chat content for an input item: plain text, or text and image parts when
// the item carries images. The chat path sends the image bytes to the model.
function chatContent(content) {
  const parts = Array.isArray(content) ? content : [content];
  if (!parts.some(isImagePart)) return contentText(content);
  return parts.map(part => {
    if (!isImagePart(part)) return { type: 'text', text: partText(part) };
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    return { type: 'image_url', image_url: { url } };
  }).filter(part => part.type !== 'text' || part.text);
}

function messageText(content) {
  if (!Array.isArray(content)) return content;
  return content.map(part => part.type === 'text' ? part.text : '[image]').join('\n');
}

function chatRole(role) {
  // Local chat templates know system, user, assistant and tool.
  return role === 'developer' ? 'system' : role;
}

// Maps each offered function name back to the Responses tool that owns it.
function chatTools(tools) {
  const names = new Map();
  const offered = [];
  const offer = (tool, namespace = null) => {
    const name = namespace ? `${namespace}${NAMESPACE_SEPARATOR}${tool.name}` : tool.name;
    if (!name || names.has(name)) return;
    if (tool.type === 'function') {
      names.set(name, { name: tool.name, namespace, kind: 'function' });
      offered.push({ type: 'function', function: {
        name, ...(tool.description && { description: tool.description }),
        parameters: tool.parameters || { type: 'object', properties: {} }
      } });
    } else if (tool.type === 'custom') {
      names.set(name, { name: tool.name, namespace, kind: 'custom' });
      offered.push({ type: 'function', function: {
        name, description: [tool.description, 'Pass the complete raw text as `input`.'].filter(Boolean).join('\n\n'),
        parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
      } });
    }
  };
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === 'namespace') for (const inner of tool.tools || []) offer(inner, tool.name);
    else offer(tool);
  }
  return { tools: offered, names };
}

function chatName(item) {
  return item.namespace ? `${item.namespace}${NAMESPACE_SEPARATOR}${item.name}` : item.name;
}

function chatToolChoice(choice, names) {
  if (choice == null || typeof choice === 'string') return choice;
  if (choice.type === 'function' || choice.type === 'custom') {
    const name = chatName(choice);
    return names.has(name) ? { type: 'function', function: { name } } : 'auto';
  }
  return 'auto';
}

function chatMessages(body) {
  const messages = [];
  const instructions = contentText(body.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });
  const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input) || input.length === 0) throw invalidRequest('input must be a non-empty string or array');
  const toolNames = new Map();
  const assistantForCalls = () => {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') return last;
    const message = { role: 'assistant', content: '' };
    messages.push(message);
    return message;
  };
  for (const item of input) {
    const type = item?.type || (item?.role ? 'message' : null);
    if (type === 'message') {
      messages.push({ role: chatRole(item.role), content: chatContent(item.content) });
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const name = chatName(item);
      const callId = String(item.call_id || item.id || '');
      toolNames.set(callId, name);
      const message = assistantForCalls();
      message.tool_calls = [...(message.tool_calls || []), {
        id: callId,
        type: 'function',
        function: { name, arguments: type === 'custom_tool_call' ? JSON.stringify({ input: item.input ?? '' }) : String(item.arguments || '{}') }
      }];
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const callId = String(item.call_id || '');
      messages.push({ role: 'tool', tool_call_id: callId, ...(toolNames.has(callId) && { tool_name: toolNames.get(callId) }),
        content: chatContent(item.output) });
    } else if (!IGNORED_INPUT_ITEMS.has(type)) {
      throw invalidRequest(`unsupported Responses input item: ${type || 'unknown'}`);
    }
  }
  return foldHistory(messages);
}

// Core accepts at most 512 chat messages. A long tool-driven session reaches
// that count well before its token budget, so the oldest turns are folded into
// one text message instead of refusing the whole session. A kept tail never
// starts with a tool result whose call was folded.
const CORE_MESSAGE_LIMIT = 512;

function transcriptLine(message) {
  const calls = (message.tool_calls || []).map(call => `[${message.role} called ${call.function?.name}(${call.function?.arguments || ''})]`);
  const label = message.role === 'tool' ? `[tool result${message.tool_name ? ` ${message.tool_name}` : ''}]` : `[${message.role}]`;
  const text = messageText(message.content);
  return [text ? `${label} ${text}` : '', ...calls].filter(Boolean).join('\n');
}

function foldHistory(messages, limit = CORE_MESSAGE_LIMIT) {
  if (messages.length <= limit) return messages;
  let headLength = 0;
  while (headLength < messages.length && messages[headLength].role === 'system') headLength += 1;
  let tailStart = messages.length - (limit - headLength - 1);
  while (tailStart < messages.length && messages[tailStart].role === 'tool') tailStart += 1;
  const folded = messages.slice(headLength, tailStart).map(transcriptLine).filter(Boolean).join('\n\n');
  return [
    ...messages.slice(0, headLength),
    { role: 'user', content: `Earlier part of this conversation, condensed to text by the AgentX gateway:\n\n${folded}` },
    ...messages.slice(tailStart)
  ];
}

function responseFormat(text) {
  const format = text?.format;
  if (!format || format.type === 'text') return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    return { type: 'json_schema', json_schema: { name: format.name, schema: format.schema, strict: format.strict } };
  }
  return undefined;
}

// Returns the chat-completions body and the tool-name map the answer needs.
function chatRequest(body) {
  if (!body || typeof body !== 'object') throw invalidRequest('request body must be a JSON object');
  if (body.previous_response_id) throw invalidRequest('previous_response_id is not supported: send the full input with store=false');
  const { tools, names } = chatTools(body.tools);
  return {
    names,
    chat: {
      model: body.model,
      messages: chatMessages(body),
      stream: body.stream === true,
      ...(tools.length && { tools, tool_choice: chatToolChoice(body.tool_choice, names) }),
      temperature: body.temperature,
      top_p: body.top_p,
      max_tokens: body.max_output_tokens,
      response_format: responseFormat(body.text),
      reasoning_effort: body.reasoning?.effort,
      user: body.user
    }
  };
}

function responseUsage(usage) {
  const input = Number(usage?.prompt_tokens || 0);
  const output = Number(usage?.completion_tokens || 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: Number(usage?.prompt_tokens_details?.cached_tokens || 0) },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number(usage?.completion_tokens_details?.reasoning_tokens || 0) },
    total_tokens: Number(usage?.total_tokens || input + output)
  };
}

const itemId = prefix => `${prefix}_agentx_${randomUUID().replace(/-/g, '')}`;

function reasoningItem(text, id = itemId('rs')) {
  return { type: 'reasoning', id, summary: [{ type: 'summary_text', text }] };
}

function messageItem(text, id = itemId('msg')) {
  return { type: 'message', id, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
}

function callItem(call, names, id = itemId('fc')) {
  const offered = names.get(call.name);
  const base = { id, call_id: call.id, status: 'completed' };
  if (offered?.kind === 'custom') {
    let input = '';
    try { input = String(JSON.parse(call.arguments || '{}').input ?? ''); } catch { input = String(call.arguments || ''); }
    return { type: 'custom_tool_call', ...base, name: offered.name, ...(offered.namespace && { namespace: offered.namespace }), input };
  }
  return { type: 'function_call', ...base, name: offered?.name || call.name,
    ...(offered?.namespace && { namespace: offered.namespace }), arguments: call.arguments || '{}' };
}

function responseShell({ id, model, createdAt, status = 'in_progress', output = [], usage = null, finishReason = null }) {
  return {
    id, object: 'response', created_at: createdAt, status, model, output,
    ...(finishReason === 'length' && { incomplete_details: { reason: 'max_output_tokens' } }),
    ...(usage && { usage })
  };
}

function terminalStatus(finishReason) {
  return finishReason === 'length' ? 'incomplete' : 'completed';
}

function responseFromChat(chat, requestedModel, names) {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  if (message.reasoning_content) output.push(reasoningItem(String(message.reasoning_content)));
  const text = contentText(message.content);
  if (text) output.push(messageItem(text));
  for (const call of message.tool_calls || []) {
    output.push(callItem({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }, names));
  }
  return responseShell({
    id: itemId('resp'), model: chat?.model || requestedModel, createdAt: Number(chat?.created) || Math.floor(Date.now() / 1000),
    status: terminalStatus(choice.finish_reason), output, usage: responseUsage(chat?.usage), finishReason: choice.finish_reason
  });
}

// Chat-completions SSE (`data:` chunks, `[DONE]`) to Responses SSE events.
class ChatSseToResponsesSse extends Transform {
  constructor(requestedModel, names) {
    super();
    this.names = names;
    this.buffer = '';
    this.sequence = 0;
    this.output = [];
    this.open = { reasoning: null, message: null };
    this.calls = new Map();
    this.usage = null;
    this.finishReason = null;
    this.finished = false;
    this.response = responseShell({ id: itemId('resp'), model: requestedModel, createdAt: Math.floor(Date.now() / 1000) });
    this._event('response.created', { response: this.response });
    this._event('response.in_progress', { response: this.response });
  }

  _event(type, payload) {
    this.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...payload })}\n\n`);
  }

  _add(item) {
    const index = this.output.length;
    this.output.push(item);
    this._event('response.output_item.added', { output_index: index, item });
    return index;
  }

  _done(index, item) {
    this.output[index] = item;
    this._event('response.output_item.done', { output_index: index, item });
  }

  _closeReasoning() {
    const open = this.open.reasoning;
    if (!open) return;
    this.open.reasoning = null;
    const part = { type: 'summary_text', text: open.text };
    this._event('response.reasoning_summary_text.done', { item_id: open.id, output_index: open.index, summary_index: 0, text: open.text });
    this._event('response.reasoning_summary_part.done', { item_id: open.id, output_index: open.index, summary_index: 0, part });
    this._done(open.index, reasoningItem(open.text, open.id));
  }

  _closeMessage() {
    const open = this.open.message;
    if (!open) return;
    this.open.message = null;
    const part = { type: 'output_text', text: open.text, annotations: [] };
    this._event('response.output_text.done', { item_id: open.id, output_index: open.index, content_index: 0, text: open.text });
    this._event('response.content_part.done', { item_id: open.id, output_index: open.index, content_index: 0, part });
    this._done(open.index, messageItem(open.text, open.id));
  }

  _closeCalls() {
    for (const call of this.calls.values()) {
      const item = callItem(call, this.names, call.itemId);
      if (item.type === 'function_call') {
        this._event('response.function_call_arguments.done', { item_id: call.itemId, output_index: call.index, arguments: item.arguments });
      } else {
        this._event('response.custom_tool_call_input.done', { item_id: call.itemId, output_index: call.index, input: item.input });
      }
      this._done(call.index, item);
    }
    this.calls.clear();
  }

  _reasoning(text) {
    if (!this.open.reasoning) {
      const id = itemId('rs');
      const index = this._add({ type: 'reasoning', id, summary: [] });
      this.open.reasoning = { id, index, text: '' };
      this._event('response.reasoning_summary_part.added', { item_id: id, output_index: index, summary_index: 0,
        part: { type: 'summary_text', text: '' } });
    }
    const open = this.open.reasoning;
    open.text += text;
    this._event('response.reasoning_summary_text.delta', { item_id: open.id, output_index: open.index, summary_index: 0, delta: text });
  }

  _text(text) {
    this._closeReasoning();
    if (!this.open.message) {
      const id = itemId('msg');
      const index = this._add({ type: 'message', id, role: 'assistant', status: 'in_progress', content: [] });
      this.open.message = { id, index, text: '' };
      this._event('response.content_part.added', { item_id: id, output_index: index, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } });
    }
    const open = this.open.message;
    open.text += text;
    this._event('response.output_text.delta', { item_id: open.id, output_index: open.index, content_index: 0, delta: text });
  }

  // OpenAI upstreams stream a call in fragments sharing an `index`; the Ollama
  // translation sends each call whole with its own id.
  _toolCall(fragment) {
    this._closeReasoning();
    this._closeMessage();
    const key = Number.isInteger(fragment.index) ? `index:${fragment.index}` : `id:${fragment.id || this.calls.size}`;
    let call = this.calls.get(key);
    if (!call) {
      const name = String(fragment.function?.name || '');
      const offered = this.names.get(name);
      call = { key, id: fragment.id || itemId('call'), name, arguments: '', itemId: itemId(offered?.kind === 'custom' ? 'ctc' : 'fc') };
      const pending = callItem({ ...call, arguments: '' }, this.names, call.itemId);
      call.index = this._add({ ...pending, status: 'in_progress', ...(pending.type === 'function_call' ? { arguments: '' } : { input: '' }) });
      this.calls.set(key, call);
    }
    const delta = String(fragment.function?.arguments || '');
    if (!delta) return;
    call.arguments += delta;
    if (this.names.get(call.name)?.kind !== 'custom') {
      this._event('response.function_call_arguments.delta', { item_id: call.itemId, output_index: call.index, delta });
    }
  }

  _chunk(chunk) {
    if (chunk?.usage) this.usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.reasoning_content) this._reasoning(String(delta.reasoning_content));
    if (delta.reasoning) this._reasoning(String(delta.reasoning));
    if (delta.content) this._text(String(delta.content));
    for (const call of delta.tool_calls || []) this._toolCall(call);
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this._closeReasoning();
    this._closeMessage();
    this._closeCalls();
    const status = terminalStatus(this.finishReason);
    const response = responseShell({ ...this.response, status, output: this.output,
      usage: responseUsage(this.usage), finishReason: this.finishReason });
    this._event(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
  }

  _drain(final) {
    let boundary;
    while ((boundary = this.buffer.indexOf('\n')) !== -1 || (final && this.buffer.trim())) {
      const line = (boundary === -1 ? this.buffer : this.buffer.slice(0, boundary)).trim();
      this.buffer = boundary === -1 ? '' : this.buffer.slice(boundary + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { this._finish(); continue; }
      try { this._chunk(JSON.parse(data)); } catch { /* malformed upstream chunk is ignored */ }
    }
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += chunk.toString('utf8');
    this._drain(false);
    callback();
  }

  _flush(callback) {
    this._drain(true);
    this._finish();
    callback();
  }
}

function responsesRender(names) {
  return {
    json: (chat, model) => responseFromChat(chat, model, names),
    stream: (chatSse, model) => new ChatSseToResponsesSse(model, names)
  };
}

module.exports = {
  ChatSseToResponsesSse,
  NAMESPACE_SEPARATOR,
  chatRequest,
  foldHistory,
  responseFromChat,
  responsesRender
};
