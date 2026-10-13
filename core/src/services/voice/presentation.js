'use strict';

// Shared spoken-channel guidance; domains may add their own conversation limits.
const SPOKEN_REPLY_INSTRUCTION = 'Keep the spoken part conversational and short, in plain text without headings, Markdown, tables or code. Put the complete long answer in the screen channel when one is available and introduce it briefly aloud. When explicitly asked to read aloud, speak the complete requested content; do not summarize or shorten the reading. Preserve all necessary crisis resources, safety instructions and emergency phone numbers even when the answer needs to be longer.';

// Presentation intent only. It grants no read/tool access and never chooses the business owner.
function readingRequested(text) {
  const value = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’'-]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:(?:s il te plait|please)\s+)?(?:(?:peux tu|pourrais tu|pouvez vous|voudrais tu)\s+(?:me\s+)?lire\b|(?:lis|lisez)(?:\s+moi)?\b|(?:can|could|would) you\s+read\b|read\b)/.test(value);
}
module.exports = { SPOKEN_REPLY_INSTRUCTION, readingRequested };
