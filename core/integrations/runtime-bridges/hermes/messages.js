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
  if (messages.some(message => message?.images?.length || Array.isArray(message?.content)
    && message.content.some(part => ['image_url', 'input_image', 'image'].includes(part?.type)))) {
    throw Object.assign(new Error('Send image analysis to the Hermes vision endpoint before local reasoning.'), {
      statusCode: 400, code: 'HERMES_IMAGE_ROUTE_REQUIRED'
    });
  }
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
