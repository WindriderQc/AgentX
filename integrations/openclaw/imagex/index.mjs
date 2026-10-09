import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { registerLocalImages } from '../super-dad-memory/local-images.js';
import { runExpert, prepareImage } from './expert.mjs';

export default definePluginEntry({
  id: 'agentx-imagex',
  name: 'imageX · Hermes Image Specialist',
  description: 'Hermes advice and image planning, with generation through AgentX Core.',
  register(api) {
    const command = api.pluginConfig?.workerCommand;
    if (!command) return;
    registerLocalImages(api, {
      name: 'imagex',
      consultImage: (prompt, status) => runExpert(command, { action: 'consult', prompt, status }),
      planImage: async (request, status, actionKey) => prepareImage(request, status,
        await runExpert(command, { action: 'plan', request, status, actionKey })),
    });
  },
});
