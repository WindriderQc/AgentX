'use strict';

// Ollama's chat API takes message content as one string, images as a list of
// base64 strings beside it and tool-call arguments as an object; OpenAI
// clients send content parts and JSON text.
const IMAGE_PARTS = new Set(['image_url', 'input_image', 'image']);
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

function invalidImage(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'GATEWAY_IMAGE_INVALID' });
}

function isImagePart(part) {
  return IMAGE_PARTS.has(part?.type);
}

// Core never fetches a remote image for a client: only inline bytes are sent.
function imageData(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.url;
  const match = typeof url === 'string' && DATA_IMAGE.exec(url);
  if (!match) throw invalidImage('Images must be inline PNG, JPEG, WebP or GIF data URLs.');
  return match[1];
}

function nativeImages(message) {
  if (message?.images == null) return [];
  if (!Array.isArray(message.images) || message.images.some(image => typeof image !== 'string' || !image)) {
    throw invalidImage('Message images must be base64 strings.');
  }
  return message.images;
}

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

// Image bytes travel unchanged. Core's inference path then confirms that the
// routed model reads images before anything is dispatched.
function ollamaMessages(messages) {
  return messages.map((message) => {
    const { images: _images, ...rest } = message || {};
    const parts = Array.isArray(message?.content) ? message.content : [];
    const images = [...nativeImages(message), ...parts.filter(isImagePart).map(imageData)];
    if (images.length && !['user', 'tool'].includes(message.role)) {
      throw invalidImage('Images are accepted in user messages and tool results only.');
    }
    return {
      ...rest,
      content: textContent(message?.content),
      ...(images.length && { images }),
      ...(Array.isArray(message?.tool_calls) && {
        tool_calls: message.tool_calls.map((call) => ({
          ...call,
          function: { ...call?.function, arguments: objectArguments(call?.function?.arguments) }
        }))
      })
    };
  });
}

// The image type from the first bytes, for the description fallback.
function imageMediaType(data) {
  if (data.startsWith('iVBOR')) return 'image/png';
  if (data.startsWith('/9j/')) return 'image/jpeg';
  if (data.startsWith('R0lGOD')) return 'image/gif';
  if (data.startsWith('UklGR')) return 'image/webp';
  return null;
}

module.exports = { imageMediaType, isImagePart, ollamaMessages };
