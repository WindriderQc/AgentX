'use strict';

// Shared spoken-channel guidance; domains may add their own conversation limits.
const SPOKEN_REPLY_INSTRUCTION = 'Use natural conversational plain text without headings, Markdown, tables or code. Speak conversation, jokes, stories and explanations completely; never divert them to the screen because of a sentence or character count. For a requested long document or long list, give a useful self-contained spoken summary with its actual findings, then show the complete document or list on screen. A screen pointer or an offer to read is not a summary. Exact technical identifiers can be shown while their understandable names are spoken. Explicit reading requests speak all requested content without summarizing. Preserve all necessary crisis resources, safety instructions and emergency phone numbers.';

// Presentation intent only. It grants no read/tool access and never chooses the business owner.
const { readingRequested } = require('../../../public/js/voice/spoken-presentation');
module.exports = { SPOKEN_REPLY_INSTRUCTION, readingRequested };
