// Read-only client of the AgentX Core finance ledger. Core owns the data and
// every total; this client only forwards bounded filters and adds display
// strings so the model never converts or sums amounts itself.

const ACTIONS = {
  balances: { path: '/api/finance/balances', params: [] },
  transactions: { path: '/api/finance/transactions', params: ['account', 'from', 'to', 'q', 'category', 'tag', 'excludeCategory', 'limit'] },
  monthly: { path: '/api/finance/summary/monthly', params: ['account', 'from', 'to', 'q', 'category', 'tag', 'excludeCategory'] },
  categories: { path: '/api/finance/summary/categories', params: ['account', 'from', 'to', 'tag', 'excludeCategory'] },
  uncategorized: { path: '/api/finance/uncategorized', params: ['limit'] },
  yearly: { path: '/api/finance/summary/yearly', params: ['account', 'from', 'to', 'q', 'category', 'tag', 'excludeCategory'] },
  insights: { path: '/api/finance/insights', params: ['account', 'category', 'tag', 'months'] },
  rules: { path: '/api/finance/rules', params: [] },
  statements: { path: '/api/finance/statements', params: ['status'] },
  documents: { path: '/api/finance/documents', params: ['minCents'] },
  goals: { path: '/api/finance/goals', params: [] },
  review: { path: '/api/finance/review/monthly', params: [] }
};

// Formats integer cents the Quebec way: 1 234,56 $ (narrow no-break space
// avoided so Telegram renders a plain space).
export function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) return null;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${dollars},${String(abs % 100).padStart(2, '0')} $`;
}

// Adds a sibling "<name>Display" string next to every "<name>Cents" integer.
export function withDisplay(value) {
  if (Array.isArray(value)) return value.map(withDisplay);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = withDisplay(item);
    if (key.endsWith('Cents') && Number.isSafeInteger(item)) out[`${key.slice(0, -5)}Display`] = formatCents(item);
  }
  return out;
}

// Only the configured finance persona (default: `comptable`) sees the tool,
// never a sandboxed run or another agent.
export function financeContext(context, agentIds = ['comptable']) {
  return Boolean(context && !context.sandboxed && agentIds.includes(context.agentId)
    && String(context.sessionKey || '').startsWith(`agent:${context.agentId}:`));
}

export function createCoreFinanceClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('AgentX requires an HTTP URL');
  return async (input = {}) => {
    const action = ACTIONS[input.action];
    if (!action) throw new Error('Unsupported finance ledger question');
    const url = new URL(action.path, base);
    for (const key of action.params) {
      const value = input[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') url.searchParams.set(key, String(value).trim());
    }
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'success' || !body.data || typeof body.data !== 'object') {
      const reason = body?.message || `Core finance ledger unavailable (${response.status})`;
      throw new Error(reason);
    }
    return { action: input.action, authority: 'agentx.core', ...withDisplay(body.data) };
  };
}

// The one bounded write: rules the owner confirmed ("description contains X
// -> category, tags"). Core validates categories and re-applies every rule.
export function createCoreRulesClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/finance/rules', baseUrl);
  return async (input = {}) => {
    const transactions = (Array.isArray(input.transactions) ? input.transactions : []).map((item) => ({
      id: item?.id, category: item?.category ?? null, tags: Array.isArray(item?.tags) ? item.tags : []
    }));
    if (transactions.length) {
      const response = await fetchImpl(new URL('/api/finance/transactions/decisions', baseUrl), { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactions, createdBy: 'comptable' }) });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.status !== 'success') throw new Error(body?.message || `Core finance decisions unavailable (${response.status})`);
      if (!Array.isArray(input.rules) || !input.rules.length) return { authority: 'agentx.core', ...body.data };
    }
    const rules = (Array.isArray(input.rules) ? input.rules : []).map((rule) => ({
      pattern: rule?.pattern, category: rule?.category, tags: Array.isArray(rule?.tags) ? rule.tags : []
    }));
    if (!rules.length) throw new Error('Give at least one confirmed rule or transaction');
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules, createdBy: 'comptable' }) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'success' || !Array.isArray(body.data?.saved)) {
      throw new Error(body?.message || `Core finance rules unavailable (${response.status})`);
    }
    return { authority: 'agentx.core', ...body.data };
  };
}

// Confirms or rejects document-to-row proposals the owner approved in the conversation.
// Core ignores anything that is not a current proposal.
export function createCoreDocumentLinkClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/finance/documents/links/decide', baseUrl);
  return async (input = {}) => {
    const ids = (Array.isArray(input.ids) ? input.ids : []).map((id) => String(id)).slice(0, 20);
    if (!ids.length) throw new Error('Give at least one link id from finance_ledger action documents');
    const status = input.decision === 'confirm' ? 'confirmed' : input.decision === 'reject' ? 'rejected' : null;
    if (!status) throw new Error('decision must be confirm or reject');
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, status, createdBy: 'comptable' }) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'success') throw new Error(body?.message || `Core document links unavailable (${response.status})`);
    return { authority: 'agentx.core', ...withDisplay(body.data) };
  };
}

// Copies chosen bank statements from the Secretary into the finance inbox. Core copies only; it never deletes,
// and the normal ingestion reconciles them.
export function createCoreStatementDepositClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  const url = new URL('/api/finance/documents/statements/deposit', baseUrl);
  return async (input = {}) => {
    const ids = (Array.isArray(input.ids) ? input.ids : []).map((id) => String(id)).slice(0, 10);
    if (!ids.length) throw new Error('Give 1 to 10 statement ids from finance_ledger action documents');
    const ledger = input.ledger === 'corp' ? 'corp' : 'perso';
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, ledger }) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'success') throw new Error(body?.message || `Core statement deposit unavailable (${response.status})`);
    return { authority: 'agentx.core', ...body.data };
  };
}

// Deterministic alerts from Core. `report` returns the pending ones and marks
// them reported, so a delivery job never repeats a fact.
export function createCoreAlertsClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  return async (input = {}) => {
    const report = input.report === true;
    const url = new URL(report ? '/api/finance/alerts/report' : '/api/finance/alerts', baseUrl);
    const response = await fetchImpl(url, { method: report ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' }, ...(report && { body: '{}' }) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'success' || !Array.isArray(body.data?.alerts)) {
      throw new Error(body?.message || `Core finance alerts unavailable (${response.status})`);
    }
    return { authority: 'agentx.core', reported: report, ...withDisplay(body.data) };
  };
}

// The owner's plan (budget, debts, open items, deadlines...). `get` reads it;
// `apply` sends small operations the owner stated in the conversation.
export function createCorePlanClient({ baseUrl, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('Configure the canonical AgentX URL for this OpenClaw instance');
  return async (input = {}) => {
    const apply = input.action === 'apply';
    if (apply && (!Array.isArray(input.ops) || !input.ops.length)) throw new Error('Give at least one plan operation');
    const url = new URL(apply ? '/api/finance/plan/ops' : '/api/finance/plan', baseUrl);
    const response = await fetchImpl(url, { method: apply ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json' }, ...(apply && { body: JSON.stringify({ ops: input.ops }) }) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'success') throw new Error(body?.message || `Core finance plan unavailable (${response.status})`);
    return { authority: 'agentx.core', ...withDisplay(body.data) };
  };
}
