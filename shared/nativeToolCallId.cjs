'use strict';

// A native call identity is opaque. Responses providers may combine call and
// item IDs with a pipe; retain both parts for exact admission and result joins.
// Tool names and model-facing parameters keep their own stricter validation.
const isNativeToolCallId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:|\-]{1,160}$/.test(value);

module.exports = { isNativeToolCallId };
