// The finance line of the morning brief, read from Core. It never fails the brief: when Core
// does not answer, or the line is empty or looks like it carries an amount, the section is omitted.

const AMOUNT_OR_ACCOUNT = /\$|\d{3,}/;

export function createCoreFinanceBriefClient({ baseUrl, fetchImpl = fetch } = {}) {
  const url = baseUrl ? new URL('/api/finance/brief', baseUrl) : null;
  return async () => {
    if (!url) return null;
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const body = await response.json();
      const summary = body?.status === 'success' ? body.data?.summary : null;
      if (typeof summary !== 'string' || !summary.startsWith('Finances : ') || AMOUNT_OR_ACCOUNT.test(summary)) return null;
      return { text: summary };
    } catch {
      return null;
    }
  };
}
