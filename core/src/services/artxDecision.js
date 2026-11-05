'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ARTX_TOOLS } = require('./mcpArtxTools');
const SKILL = fs.readFileSync(path.resolve(__dirname, '../../../skills/agentx-artx/SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');

function createArtxDecision({ inference, consumerContract, taskType = 'voice_persona_chat' } = {}) {
  return async ({ snapshot, signal }) => {
    signal.throwIfAborted();
    const schema = ARTX_TOOLS.find(tool => tool.name === 'artx_present').inputSchema;
    const { displayId, requestId, ...properties } = schema.properties;
    const result = await inference.execute({ mode: 'chat', taskType, stream: false, think: false,
      messages: [{ role: 'system', content: SKILL + '\nThis is your silent idle task. Call artx_present exactly once with your choice. Do not speak. The tool is the only permitted action.' },
        { role: 'user', content: JSON.stringify({ at: snapshot.at, weather: snapshot.weather, sun: snapshot.sun,
          sky: snapshot.sky ? { moon: snapshot.sky.moon, planets: snapshot.sky.planets } : null,
          paintings: snapshot.paintings }) }],
      tools: [{ type: 'function', function: { name: 'artx_present', description: 'Choose your next silent ArtX scene.',
        parameters: { type: 'object', properties, required: ['mode'], additionalProperties: false } } }],
      options: { temperature: 0.3, num_predict: 200 }, timeoutMs: 45000, callerDetail: 'agentx-household/nestor/artx-idle'
    // Once admitted, let native inference settle and release normally. Activity
    // invalidates the selection; aborting admitted compute can quarantine a host.
    }, { consumerContract });
    signal.throwIfAborted();
    if (!result?.ok) throw Object.assign(new Error('The idle ArtX task could not run.'), { code: 'ARTX_INFERENCE_UNAVAILABLE' });
    const calls = result.body?.message?.tool_calls;
    if (calls?.length !== 1 || calls[0].function?.name !== 'artx_present') throw new Error('ArtX requires one explicit scene choice.');
    const args = calls[0].function.arguments;
    const selected = typeof args === 'string' ? JSON.parse(args) : args;
    return { mode: selected?.mode, ...(selected?.paintingId ? { paintingId: selected.paintingId } : {}) };
  };
}

module.exports = { createArtxDecision };
