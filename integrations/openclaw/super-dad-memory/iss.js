import { agentxRead } from './harness.js';
import { photoAudience } from './photos.js';

// ISS passes over the home, computed by AgentX Core (iss_passes) from the
// orbital elements and household location Data already holds. The result
// omits coordinates but remains household-specific. The adapter binds the
// shared tool to approved owner/household session identities; other sessions
// get no tool. Granted per agent in tools.alsoAllow.

const receipt = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });

export function registerIss(api, { fetchImpl = fetch, name = 'nestor_iss' } = {}) {
  api.registerTool(context => {
    if (!photoAudience(context, api.config)) return null;
    return {
      name, label: 'ISS Passes',
      description: [
        'When will the International Space Station pass over the house? Returns dated passes computed by AgentX:',
        'for each, local rise/set times and directions, highest point, and whether it is observable to the naked eye',
        '(at least 10° high, station sunlit, dark enough sky) or only above the horizon, with the reason.',
        'Quote the returned local times and days exactly; never estimate a time yourself. Weather is unknown: say "si le ciel est dégagé".',
        'Follow Core answerRules; limit comparisons to the returned search window.',
        'If tle.stale is true, mention how old the orbital data is. If view.url is present, offer it in a show block of kind link.',
        'visible_only=true keeps observable passes; hours sets the window (default 72, at most 108). Read-only.',
      ].join(' '),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          hours: { type: 'integer', minimum: 1, maximum: 108 },
          visible_only: { type: 'boolean' },
          max_passes: { type: 'integer', minimum: 1, maximum: 12 },
        },
      },
      async execute(_id, params = {}) {
        const args = {};
        for (const key of ['hours', 'visible_only', 'max_passes']) if (params[key] !== undefined) args[key] = params[key];
        return receipt(await agentxRead(api.pluginConfig?.agentxUrl, 'iss_passes', args, fetchImpl));
      },
    };
  }, { name, optional: true });
}
