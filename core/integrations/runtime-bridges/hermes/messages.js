'use strict';

// Ollama's chat API takes message content as one string and tool-call
// arguments as an object; OpenAI clients send content parts and JSON text.
function textContent(content) {
  if (!Array.isArray(content)) return content;
  return content
    .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

function objectArguments(value) {
  if (typeof value !== 'string') return value || {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function ollamaMessages(messages) {
  return messages.map((message) => ({
    ...message,
    content: textContent(message?.content),
    ...(Array.isArray(message?.tool_calls) && {
      tool_calls: message.tool_calls.map((call) => ({
        ...call,
        function: { ...call?.function, arguments: objectArguments(call?.function?.arguments) }
      }))
    })
  }));
}

module.exports = { ollamaMessages };
