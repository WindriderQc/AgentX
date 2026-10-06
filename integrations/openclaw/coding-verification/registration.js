import { buildTool, fileToolGate, grantRoot } from './runner.js';

export function register(api) {
    const config = api.pluginConfig || {};
    const agents = Array.isArray(config.agentIds) ? config.agentIds : [];
    // Without the file hook, a task worktree cannot protect ignored dependencies.
    if (typeof api.on !== 'function' || typeof api.registerGatewayMethod !== 'function') {
      throw new Error('Coding verification requires file hooks and Gateway readiness support');
    }
    api.on('before_tool_call', (event, context) => fileToolGate(event, context, {
      ...config, agentIds: agents, root: grantRoot(config.grantRoot)
    }), { priority: 80, timeoutMs: 10000 });
    api.registerTool(context => buildTool(context, { ...config, agentIds: agents }), {
      name: 'agentx_coding_verify', optional: true
    });
    api.registerGatewayMethod('agentx.coding-verification.status', ({ params, respond }) => {
      const entries = api.config?.agents?.entries || {};
      const agent = entries[params.agentId] || api.config?.agents?.list?.find(value => value.id === params.agentId);
      const tools = agent?.tools || {};
      const allowed = [...(tools.allow || []), ...(tools.alsoAllow || [])];
      respond(true, {
        schema: 'agentx.coding-verification-readiness/v1',
        ready: agents.includes(params.agentId) && allowed.includes('agentx_coding_verify')
          && !(tools.deny || []).some(value => ['agentx_coding_verify', 'agentx-coding-verification', 'group:plugins'].includes(value)),
        helperPath: config.helperPath, grantRoot: grantRoot(config.grantRoot), fileScopeHook: true
      });
    }, { scope: 'operator.read' });
}
