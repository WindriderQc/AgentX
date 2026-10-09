const policy = require('../../src/services/memoryReview/policy');

const candidate = (trusts, overrides = {}) => ({
  type: 'preference', target: { kind: 'shared_fact' }, confidence: 0.99,
  sensitivity: 'normal', impact: 'context_only', risk: { governance: 'none' },
  recurrence: { observationCount: 3, independentSessions: 3 }, conflicts: [],
  evidence: trusts.map((trust) => ({ trust })), ...overrides,
});

describe('household member evidence', () => {
  test('is admitted for central submission', () => {
    expect(policy.CENTRAL_SUBMISSION_TRUST).toContain('household_member_statement');
    expect(policy.TRUST_CLASSES).toContain('household_member_statement');
  });

  test('the same candidate applies from owner words and waits for review from a member', () => {
    expect(policy.automationDecision(candidate(['authenticated_owner_statement'])).disposition).toBe('auto_apply');
    expect(policy.automationDecision(candidate(['household_member_statement']))).toEqual({
      disposition: 'review', evidenceClass: 'household_member', reason: 'household-member-evidence',
    });
  });

  test('owner or explicit evidence beside it does not vouch for it', () => {
    for (const other of ['authenticated_owner_statement', 'explicit_memory_request', 'verified_git_or_test_outcome']) {
      expect(policy.automationDecision(candidate([other, 'household_member_statement'])).disposition).toBe('review');
    }
    const pattern = candidate(['household_member_statement'], { type: 'inferred_pattern', target: { kind: 'soft_memory' } });
    expect(policy.automationDecision(pattern).disposition).toBe('review');
  });
});
