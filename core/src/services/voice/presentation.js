'use strict';

// Shared spoken-channel guidance; domains may add their own conversation limits.
const SPOKEN_REPLY_INSTRUCTION = 'Use short conversational plain text, without headings, Markdown, tables or code. Beyond about three sentences or 600 characters, briefly introduce ordinary answers aloud and show the complete text on screen. Explicit reading requests speak all requested content without summarizing. Preserve all necessary crisis resources, safety instructions and emergency phone numbers in long replies.';

// Presentation intent only. It grants no read/tool access and never chooses the business owner.
const { readingRequested } = require('../../../public/js/voice/spoken-presentation');
module.exports = { SPOKEN_REPLY_INSTRUCTION, readingRequested };
