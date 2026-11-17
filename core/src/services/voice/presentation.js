'use strict';

// Shared spoken-channel guidance; domains may add their own conversation limits.
const SPOKEN_REPLY_INSTRUCTION = 'Plain text without headings, Markdown, tables or code in speech. A detailed answer may use a concise, self-contained spoken summary for conversational flow only when its complete written answer is also supplied for display. Never shorten the written answer to fit speech, drop details, or replace the useful spoken answer with a mere screen pointer. Without a complete written counterpart, keep the answer complete. Speak readable model names; display exact IDs. Explicit reading: full content. Preserve all necessary crisis resources, safety instructions and emergency phone numbers.';

// Presentation intent only. It grants no read/tool access and never chooses the business owner.
const { readingRequested } = require('../../../public/js/voice/spoken-presentation');
module.exports = { SPOKEN_REPLY_INSTRUCTION, readingRequested };
