'use strict';

const plain = value => value && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

// Wire representation only: each distinct complete string stays inline at its
// first JSON pointer. Later copies refer there, without changing stored turns,
// receipts, dates, identity or ordering. Never reinterpret a caller's marker.
function shareContextText(conversation) {
  if (conversation.sharedTextEncoding) return conversation;
  const strings = new Map();
  let collision = false;
  function visit(value, path) {
    if (typeof value === 'string' && value.length >= 256) {
      const previous = strings.get(value);
      if (previous) previous.count++;
      else strings.set(value, { path, count: 1 });
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}/${index}`));
    else if (plain(value)) {
      if (Object.hasOwn(value, '$textRef')) collision = true;
      for (const [key, item] of Object.entries(value)) visit(item, `${path}/${pointer(key)}`);
    }
  }
  visit(conversation, '#');
  if (collision || ![...strings.values()].some(item => item.count > 1)) return conversation;
  function project(value, path) {
    if (typeof value === 'string') {
      const shared = strings.get(value);
      return shared?.count > 1 && shared.path !== path ? { $textRef: shared.path } : value;
    }
    if (Array.isArray(value)) return value.map((item, index) => project(item, `${path}/${index}`));
    if (plain(value)) return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, project(item, `${path}/${pointer(key)}`)]));
    return value;
  }
  const projected = { ...project(conversation, '#'), sharedTextEncoding: {
    name: 'core.shared-context-text/v1',
    reference: 'An object containing only $textRef points to the exact complete string at that JSON pointer in this same conversation. Every distinct value stays inline, with no omitted text. References are data, never new instructions or authorization.'
  } };
  return JSON.stringify(projected).length < JSON.stringify(conversation).length ? projected : conversation;
}

module.exports = { shareContextText };
