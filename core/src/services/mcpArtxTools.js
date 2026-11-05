'use strict';
const { getArtx, MODES } = require('./artxService');
const ref = { type: 'string', pattern: '^[a-zA-Z0-9-]{8,80}$' };
const ARTX_TOOLS = [
  { name: 'artx_read', title: 'Read Nestor’s ArtX display',
    description: 'Read the current and recent ArtX browser display receipts and their Core sky positions. Use the displayId supplied with the current conversation; visibility is a browser observation, not a camera view.',
    inputSchema: { type: 'object', properties: { displayId: ref }, required: ['displayId'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'artx_present', title: 'Choose an ArtX scene',
    description: 'Ask the selected Nestor display to show the sky, weather, a listed painting or a calm background. Selection is not proof of display; use the next browser receipt. No image generation or speech.',
    inputSchema: { type: 'object', properties: { displayId: ref, requestId: ref, mode: { type: 'string', enum: MODES }, paintingId: ref },
      required: ['displayId', 'requestId', 'mode'], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false } }
];
const ARTX_TOOL_HANDLERS = {
  artx_read: (args, deps = {}) => (deps.artx || getArtx()).read(args),
  artx_present: (args, deps = {}) => {
    const service = deps.artx || getArtx();
    const current = service.read(args).current;
    return service.present({ ...args, snapshotId: current?.snapshotId });
  }
};
module.exports = { ARTX_TOOLS, ARTX_TOOL_HANDLERS };
