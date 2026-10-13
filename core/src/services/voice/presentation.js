'use strict';

// Shared spoken-channel guidance; domains may add their own conversation limits.
const SPOKEN_REPLY_INSTRUCTION = 'Keep the spoken part conversational and short, in plain text without headings, Markdown, tables or code. Briefly introduce long answers aloud; show their complete text on screen when available. For explicit reading requests, speak all requested content without summarizing. Preserve all necessary crisis resources, safety instructions and emergency phone numbers, even in longer replies.';

// Presentation intent only. It grants no read/tool access and never chooses the business owner.
function readingRequested(text) {
  const value = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’'-]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:(?:s il te plait|please)\s+)?(?:(?:peux tu|pourrais tu|pouvez vous|voudrais tu)\s+(?:me\s+)?lire\b|(?:lis|lisez)(?:\s+moi)?\b|(?:can|could|would) you\s+read\b|read\b)/.test(value);
}
module.exports = { SPOKEN_REPLY_INSTRUCTION, readingRequested };
