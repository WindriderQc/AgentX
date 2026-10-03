'use strict';

const {
  createPromptPrefixTracker,
  sanitizePromptPrefix,
} = require('../../src/services/routing/promptPrefixFingerprint');

const HOST = 'http://ollama.test:11434';
const SYSTEM = [
  'You are a synthetic assistant.',
  '## Tooling',
  'Use the read tool for files.',
  '## Runtime',
  'Current time: 09:00',
].join('\n');
const TOOLS = [{ type: 'function', function: { name: 'read', description: 'Read a synthetic file' } }];

function prompt({ system = SYSTEM, tools = TOOLS, turns = ['first question'] } = {}) {
  return {
    hostUrl: HOST,
    model: 'model-a',
    tools,
    messages: [
      { role: 'system', content: system },
      ...turns.map((content, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content })),
    ],
  };
}

describe('prompt prefix fingerprint', () => {
  let tracker;
  beforeEach(() => { tracker = createPromptPrefixTracker(); });

  test('the first call for a host and model has no previous prompt to compare with', () => {
    expect(tracker.observe(prompt())).toEqual({
      systemSections: 3,
      messages: 1,
      toolsHash: expect.stringMatching(/^[0-9a-f]{8}$/),
      divergence: { kind: 'first', index: null, heading: null },
    });
  });

  test('an identical prompt does not diverge', () => {
    tracker.observe(prompt());
    expect(tracker.observe(prompt()).divergence).toEqual({ kind: 'none', index: null, heading: null });
  });

  test('a changed system section reports its position and harness heading', () => {
    tracker.observe(prompt());
    const changed = tracker.observe(prompt({ system: SYSTEM.replace('09:00', '09:05') }));
    expect(changed.divergence).toEqual({ kind: 'system', index: 2, heading: 'Runtime' });
  });

  test('a changed tools array diverges after an unchanged system prompt', () => {
    const first = tracker.observe(prompt());
    const changed = tracker.observe(prompt({ tools: [...TOOLS, { type: 'function', function: { name: 'write' } }] }));
    expect(changed.divergence).toEqual({ kind: 'tools', index: null, heading: null });
    expect(changed.toolsHash).not.toBe(first.toolsHash);
  });

  test('an appended message keeps the previous prompt as an intact prefix', () => {
    tracker.observe(prompt());
    const next = tracker.observe(prompt({ turns: ['first question', 'first answer', 'second question'] }));
    expect(next).toMatchObject({ messages: 3, divergence: { kind: 'append', index: 1, heading: null } });
  });

  test('a rewritten earlier message reports the first changed message', () => {
    tracker.observe(prompt({ turns: ['first question', 'first answer', 'second question'] }));
    const next = tracker.observe(prompt({ turns: ['first question', 'compacted answer', 'second question', 'third'] }));
    expect(next.divergence).toEqual({ kind: 'message', index: 1, heading: null });
  });

  test('a tool call that changes only the assistant tool payload is a different message', () => {
    const call = name => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: {} } }] });
    tracker.observe({ hostUrl: HOST, model: 'model-a', messages: [{ role: 'user', content: 'go' }, call('read')] });
    const next = tracker.observe({ hostUrl: HOST, model: 'model-a', messages: [{ role: 'user', content: 'go' }, call('write')] });
    expect(next.divergence).toEqual({ kind: 'message', index: 1, heading: null });
  });

  test('host and model pairs are compared separately and the map stays bounded', () => {
    const small = createPromptPrefixTracker({ maxTargets: 2 });
    small.observe({ ...prompt(), model: 'model-a' });
    small.observe({ ...prompt(), model: 'model-b' });
    expect(small.observe({ ...prompt(), model: 'model-a' }).divergence.kind).toBe('none');
    small.observe({ ...prompt(), model: 'model-c' });
    // model-b was the least recently used target and has been forgotten.
    expect(small.observe({ ...prompt(), model: 'model-b' }).divergence.kind).toBe('first');
    expect(small.observe({ ...prompt(), hostUrl: 'http://other.test:11434' }).divergence.kind).toBe('first');
  });

  test('the summary carries no prompt text and truncates headings', () => {
    const secret = 'synthetic-private-detail-4242';
    const longHeading = `## ${'H'.repeat(80)}`;
    tracker.observe(prompt({ system: `${longHeading}\n${secret}`, turns: [secret] }));
    const summary = tracker.observe(prompt({ system: `${longHeading}\n${secret}!`, turns: [secret] }));
    expect(summary.divergence).toEqual({ kind: 'system', index: 0, heading: 'H'.repeat(40) });
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(JSON.stringify(summary)).not.toContain('Read a synthetic file');
  });

  test('a malformed request never throws into inference', () => {
    const cyclic = { role: 'user' };
    cyclic.content = cyclic;
    expect(tracker.observe({ hostUrl: HOST, model: 'model-a', messages: [cyclic] })).toBeNull();
  });

  test('sanitization keeps only the documented payload-free shape', () => {
    expect(sanitizePromptPrefix({
      systemSections: 4, messages: 12, toolsHash: 'abcdef12', extra: 'prompt text',
      divergence: { kind: 'system', index: 2, heading: `Runtime\n${'x'.repeat(60)}`, content: 'prompt text' },
    })).toEqual({
      systemSections: 4, messages: 12, toolsHash: 'abcdef12',
      divergence: { kind: 'system', index: 2, heading: `Runtime ${'x'.repeat(32)}` },
    });
    expect(sanitizePromptPrefix({ systemSections: -1, messages: 1.5, toolsHash: 'not-hex!',
      divergence: { kind: 'prompt text' } })).toEqual({
      systemSections: null, messages: null, toolsHash: null, divergence: null,
    });
    expect(sanitizePromptPrefix('prompt text')).toBeNull();
  });
});
