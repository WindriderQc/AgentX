import { configuredJobContext, privateOwnerContext } from '../action-provenance.mjs';

export { configuredJobContext };

// The native tool is a client of Core, never a second personal-note store.
export function createCoreNotesClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/consumers/nestor/v1/memory/notes', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AgentX requires an HTTP URL');
  return async input => {
    const action = input?.action;
    if (!['remember', 'forget', 'list', 'search', 'search_family', 'context'].includes(action)) throw new Error('Unsupported personal-memory operation');
    const familySearch = action === 'search_family';
    if (familySearch && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000)) {
      throw new Error('Family note search requires a query of 1-2000 characters');
    }
    const payload = { action };
    const keys = familySearch ? ['query', 'limit'] : ['id', 'text', 'query', 'kind', 'expiresAt', 'limit', 'offset', 'provenance', 'includeHistory'];
    for (const key of keys) {
      if (Object.hasOwn(input, key)) payload[key] = input[key];
    }
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (familySearch && !response.ok) throw new Error(`Core family-note search unavailable (${response.status})`);
    if (!response.ok) throw new Error(`Core personal notes unavailable (${response.status}); refresh before retrying a write`);
    const body = await response.json();
    const data = body.data;
    if (familySearch && (data?.memorySpace !== 'family' || !Array.isArray(data.notes)
        || data.notes.some(note => note?.scope !== 'household' || note.sensitivity !== 'normal'))) {
      throw new Error('Core family-note receipt is invalid');
    }
    if (body.status !== 'success' || data?.ok !== true || data.authority !== 'agentx.core' || data.operation !== action
        || (['list', 'search', 'context'].includes(action) && !Array.isArray(data.notes))
        || (['remember', 'forget'].includes(action) && !/^[a-f0-9]{24}$/.test(data.id || ''))
        // Core may replace an identifier by a vault reference; nothing else may change.
        || (action === 'remember' && data.text !== input.text?.trim() && !(data.sealed?.length && data.text?.includes('[coffre: ')))
        || (action === 'forget' && data.id !== input.id)) {
      throw new Error('Core personal-note receipt is invalid; refresh before retrying a write');
    }
    return { ...data, action };
  };
}

export function registerPersonalMemory(api, readNotes) {
  api.registerTool(context => {
    const owner = privateOwnerContext(context, api.config);
    const secretary = configuredJobContext(context, api.pluginConfig?.secretarySessionKeys);
    if (!owner && !secretary) return null;
    const canSearchFamily = owner && !secretary;
    const actions = ['remember', 'list', 'search', 'forget'];
    if (canSearchFamily) actions.push('search_family');
    const description = 'Remember only an explicit, lasting personal fact, preference or decision in one sentence. Never a summary of a mail, thread or document (use mail_journal), never identifiers or account numbers. Search/list private notes; correct a note using its existing id; forget an exact id. Notes use AgentX Core, shared with the owner Nestor UI and voice. Confirm only the receipt; forgetting does not erase chat history.';
    return {
      name: 'personal_memory', label: 'Personal Memory',
      description: description + (canSearchFamily ? ' To search shared family notes, use search_family with a query. This reads the family space configured in Core.' : ''),
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: actions },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        query: { type: 'string', maxLength: 2000 },
        id: { type: 'string', pattern: '^[a-f0-9]{24}$' },
        kind: { type: 'string', enum: ['fact', 'preference', 'decision'] },
        expiresAt: { type: 'string', maxLength: 40 },
        includeHistory: { type: 'boolean', description: 'Explicit list only: include replaced facts and successor links within this owner space.' }
      }, required: ['action'], additionalProperties: false },
      async execute(_callId, params) {
        if (params.action === 'search_family' && !canSearchFamily) throw new Error('Family note search requires a private owner turn');
        // The session, not the model, says where a remembered fact came from.
        const morning = configuredJobContext(context, api.pluginConfig?.briefingSessionKeys);
        const provenance = secretary ? 'mail-review' : morning ? 'scheduled' : 'conversation';
        const data = await readNotes(params.action === 'remember' ? { ...params, provenance } : params);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data };
      }
    };
  }, { name: 'personal_memory', optional: true });
}
