import { privateOwnerContext } from './store.js';
import { agentxRead } from './harness.js';

// Protocol adapter only: Core owns snapshot projection, expiry and validation.
export function registerPresentation(api, { fetchImpl = fetch } = {}) {
  api.registerTool(context => {
    if (!privateOwnerContext(context, api.config)) return null;
    return {
      name: 'nestor_read_presentation', label: 'Read Presented Content',
      description: 'Read the exact Core Analytics snapshot referenced by the current presentation context. Supply its id and revision. Never guesses the active page from history, fetches external pages or retries business actions. An unavailable receipt requires refreshing the view. A data receipt does not prove browser display.',
      parameters: { type: 'object', additionalProperties: false, required: ['id', 'revision'], properties: {
        id: { type: 'string', pattern: '^view_[a-f0-9]{64}$' }, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }
      } },
      async execute(_id, { id, revision } = {}) {
        const value = await agentxRead(api.pluginConfig?.agentxUrl, 'read_presentation', { id, revision }, fetchImpl);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
      }
    };
  }, { name: 'nestor_read_presentation', optional: true });
}
