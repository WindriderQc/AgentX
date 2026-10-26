'use strict';

// The normal telemetry builder already excludes messages and completions.
// Provider error strings can still echo content. Retain a content-free error
// marker on this server-selected path, including asynchronous stream settlement.
function redact(entry, options) {
  if (options?.contentRetention !== 'ephemeral') return entry;
  return { ...entry, error: entry.error ? 'ephemeral_inference_failed' : null };
}
module.exports = { redact };
