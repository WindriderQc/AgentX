'use strict';

// Shared spoken-channel guidance; domains may add their own conversation limits.
const SPOKEN_REPLY_INSTRUCTION = 'Plain text without headings, Markdown, tables or code. Speak conversations, jokes, stories and explanations fully regardless of length. Long documents/lists: useful spoken summary of findings, full text on screen; no mere screen pointer. Speak readable model names; display exact IDs. Explicit reading: full content. Preserve all necessary crisis resources, safety instructions and emergency phone numbers.';

// Presentation intent only. It grants no read/tool access and never chooses the business owner.
const { readingRequested } = require('../../../public/js/voice/spoken-presentation');
module.exports = { SPOKEN_REPLY_INSTRUCTION, readingRequested };
