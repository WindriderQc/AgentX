const { brief, members, formatCents } = require('../../src/services/teamBriefService');

const now = () => new Date('2026-03-15T12:00:00.000Z');

function sources(overrides = {}) {
  const calls = [];
  return { calls,
    mailJournal: { search: async input => { calls.push(['mail', input]); return { ok: true, entries: [{ threadId: 't1', subject: 'Synthetic subject', summary: 'Synthetic digest.' }], total: 1, truncated: false }; } },
    financeQuery: {
      balances: async () => ({ accounts: [{ code: 'EOP', balanceCents: 123456, asOf: '2026-03-10' }] }),
      transactions: async input => { calls.push(['transactions', input]); return { rows: [{ date: '2026-02-27', description: 'Synthetic row', flowCents: -1200 }], totals: {} }; },
      monthly: async input => { calls.push(['monthly', input]); return { months: [{ month: '2026-03', inCents: 500000, outCents: -420050, netCents: 79950 }] }; },
      statements: async input => { calls.push(['statements', input]); return { statements: [] }; }
    },
    financeAlerts: { list: async () => ({ alerts: [] }) },
    emailActions: { recent: async input => { calls.push(['actions', input]); return { actions: [{ threadId: 't9', category: 'Needs Reply', action: 'Synthetic action.', sender: 'Synthetic sender' }] }; } },
    ...overrides };
}

describe('the standing brief of a collaborator', () => {
  test('every collaborator answers with the same envelope', async () => {
    for (const member of members()) {
      const result = await brief({ member }, { sources: sources(), now });
      expect(result).toMatchObject({ ok: true, authority: 'agentx.core', kind: 'team_brief', member, asOf: '2026-03-15T12:00:00.000Z' });
      expect(Object.keys(result).sort()).toEqual(['asOf', 'authority', 'beyond', 'covers', 'kind', 'member', 'ok', 'sections', 'since', 'title']);
      expect(typeof result.covers).toBe('string');
      expect(typeof result.beyond).toBe('string');
    }
  });

  test('the Secretary shares her recent mail journal, newest first by default over two days', async () => {
    const s = sources();
    const result = await brief({ member: 'Secretary' }, { sources: s, now });
    expect(s.calls).toContainEqual(['mail', { since: '2026-03-13T12:00:00.000Z', limit: 20 }]);
    expect(s.calls).toContainEqual(['actions', { since: new Date('2026-03-13T12:00:00.000Z'), now: new Date('2026-03-15T12:00:00.000Z') }]);
    expect(result.sections.flaggedForOwner.actions[0]).toMatchObject({ threadId: 't9', category: 'Needs Reply' });
    expect(result.sections.mail).toEqual({ entries: [{ threadId: 't1', subject: 'Synthetic subject', summary: 'Synthetic digest.' }], total: 1, truncated: false });
    await brief({ member: 'secretary', days: 7 }, { sources: s, now });
    expect(s.calls.filter(call => call[0] === 'mail').at(-1)[1].since).toBe('2026-03-08T12:00:00.000Z');
  });

  test('the accountant shares balances, recent months, alerts and statements to review, with display amounts', async () => {
    const s = sources();
    const { sections } = await brief({ member: 'comptable' }, { sources: s, now });
    expect(sections.balances.accounts[0]).toMatchObject({ balanceCents: 123456, balanceDisplay: '1 234,56 $' });
    expect(sections.recentMonths.months[0]).toMatchObject({ outDisplay: '-4 200,50 $', netDisplay: '799,50 $' });
    expect(s.calls).toContainEqual(['monthly', { from: '2025-12-01', excludeCategory: 'Virements internes' }]);
    expect(s.calls).toContainEqual(['statements', { status: 'needs_review' }]);
    expect(sections.pendingAlerts).toEqual({ alerts: [] });
    // The ledger stops in February: March, the current month, has no data, and no transaction row leaks into the brief.
    expect(sections.freshness).toMatchObject({ latestTransactionDate: '2026-02-27', currentMonth: '2026-03', currentMonthHasData: false });
    expect(JSON.stringify(sections.freshness)).not.toContain('Synthetic row');
    expect(s.calls).toContainEqual(['transactions', { limit: 1 }]);
  });

  test('a part Core cannot read is marked unavailable and the others still answer', async () => {
    const s = sources({ financeAlerts: { list: async () => { throw new Error('alerts store offline'); } } });
    const { sections } = await brief({ member: 'comptable' }, { sources: s, now });
    expect(sections.pendingAlerts).toEqual({ unavailable: 'alerts store offline' });
    expect(sections.balances.accounts).toHaveLength(1);
  });

  test('an unknown collaborator or a bad window is refused', async () => {
    await expect(brief({ member: 'constructor' }, { sources: sources(), now })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('secretary, comptable') });
    await expect(brief({ member: 'comptable', days: 0 }, { sources: sources(), now })).rejects.toMatchObject({ statusCode: 400 });
    expect(formatCents(5)).toBe('0,05 $');
  });
});
