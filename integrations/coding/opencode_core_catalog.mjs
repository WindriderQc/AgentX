// Native OpenCode 1.19.3 config hook. Discovery reads Core metadata only;
// inference, model approval and exact host/context selection remain in Core.
const PROVIDER = 'agentx-core';
const PRIMARY = 'agentx-primary';

export default async function coreCatalog({ client }) {
  return {
    async config(config) {
      const provider = config.provider?.[PROVIDER];
      if (!provider) return;
      provider.name = 'Passerelle Core';
      const primary = provider.models?.[PRIMARY];
      if (primary) primary.name = 'Choix principal de Core · résolution indisponible';
      try {
        const base = new URL(provider.options?.baseURL);
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid gateway URL');
        base.pathname = base.pathname.replace(/\/+$/, '') + '/models';
        base.search = '';
        base.hash = '';
        const response = await fetch(base, {
          headers: { Authorization: `Bearer ${provider.options?.apiKey || ''}`, 'x-service-caller': 'opencode-model-catalog' },
          redirect: 'error', signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error('Model discovery refused');
        const catalog = await response.json();
        const models = {};
        for (const row of catalog.data || []) {
          const info = row.agentx;
          if (info?.selectable !== true || !info.resolved_model || !info.host?.name
            || !Number.isSafeInteger(info.context_window) || info.context_window <= 0
            || !(row.id === PRIMARY || /^agentx-host\/[a-z0-9_.-]+$/i.test(row.id))) continue;
          const template = row.id === PRIMARY ? primary || {} : {};
          models[row.id] = {
            ...template,
            name: `${info.resolved_model} · ${info.host.name}${row.id === PRIMARY ? ' · par défaut' : ''}`,
            limit: { ...template.limit, context: info.context_window,
              output: Math.min(template.limit?.output || primary?.limit?.output || 4096, info.context_window) },
            ...(row.id !== PRIMARY || typeof info.capabilities?.tools === 'boolean'
              ? { tool_call: info.capabilities?.tools === true } : {}),
            ...(typeof info.capabilities?.reasoning === 'boolean' && { reasoning: info.capabilities.reasoning })
          };
        }
        // Never silently switch the owner's default after a failed/partial discovery.
        if (!models[PRIMARY]) throw new Error('Principal route unavailable');
        provider.models = models;
      } catch {
        // No credentials, URL or server body in logs. The existing principal
        // alias remains usable and Core still validates it at inference time.
        if (primary) provider.models = { [PRIMARY]: primary };
        try {
          await client?.app?.log?.({ body: { service: 'agentx-model-catalog', level: 'warn',
            message: 'Core model discovery unavailable; keeping the principal alias' } });
        } catch { /* Logging availability never changes the configured route. */ }
      }
    }
  };
}
