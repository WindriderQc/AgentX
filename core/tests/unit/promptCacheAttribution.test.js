'use strict';

const {
  RELOAD_LOAD_MS,
  createPromptCacheTracker,
  promptCacheVerdict,
  promptSegments,
  sanitizePromptCache,
} = require('../../src/services/routing/promptCacheAttribution');

// Synthetic agent turns on one host and model: each agent keeps its own
// conversation, and Ollama holds one prompt cache for the model (#364).
const HOST = 'http://gpu-a:11434';
const MODEL = 'qwen35:27b';
const SECRET = 'do-not-store-this-sentence';

const system = name => `You are ${name}.\n## Tools\nUse them carefully.\n## Rules\nBe brief. ${SECRET}`;
const conversation = (name, turns) => ({
  model: MODEL,
  messages: [
    { role: 'system', content: system(name) },
    ...Array.from({ length: turns }, (_, index) => [
      { role: 'user', content: `${name} question ${index} ${'x'.repeat(400)}` },
      { role: 'assistant', content: `${name} answer ${index} ${'y'.repeat(400)}` },
    ]).flat(),
    { role: 'user', content: `${name} next question` },
  ],
});
const charsOf = payload => promptSegments(payload).reduce((sum, item) => sum + item.chars, 0);

function setup(options) {
  let clock = 1_000;
  const tracker = createPromptCacheTracker({ now: () => clock, ...options });
  const call = (payload, labels = {}, { host = HOST, model = MODEL, advance = 1_000 } = {}) => {
    clock += advance;
    return tracker.observe({ hostUrl: host, model, payload, labels });
  };
  return { tracker, call };
}

describe('prompt cache attribution', () => {
  test('a turn right after its own previous turn is warm', () => {
    const { call } = setup();
    expect(promptCacheVerdict(call(conversation('coder', 0), { kind: 'trusted-runtime' })))
      .toMatchObject({ verdict: 'untracked', lostChars: null, lostPrefillMs: null });
    const first = conversation('coder', 0);
    const observation = call(conversation('coder', 1), { kind: 'trusted-runtime' });
    // The previous turn's last user message became an answered exchange.
    expect(observation).toMatchObject({ tracked: true, interleaved: 0, interleavedBy: [] });
    expect(observation.sharedChars).toBeGreaterThan(charsOf({ messages: first.messages.slice(0, 1) }) - 1);
    expect(promptCacheVerdict(observation, { loadMs: 30, promptEvalMs: 200 }))
      .toMatchObject({ verdict: 'warm', lostChars: 0, lostPrefillMs: 0 });
  });

  test('another caller in between costs the next turn its reusable prefix, and is named', () => {
    const { call } = setup();
    const agent = { kind: 'trusted-runtime', consumerContract: 'openclaw-pipeline-runtime-v1', taskType: 'coding' };
    call(conversation('coder', 2), agent);
    call({ model: MODEL, prompt: 'Classify: hello' }, { kind: 'classifier' });
    call(conversation('nestor', 0), { kind: 'trusted-runtime', consumerContract: 'nestor-v1' });
    const next = conversation('coder', 3);
    const observation = call(next, agent);

    const reusable = charsOf(conversation('coder', 2)) - charsOf({ messages: [{ role: 'user', content: 'coder next question' }] });
    expect(observation).toMatchObject({ tracked: true, sharedChars: 0, interleaved: 2 });
    expect(observation.reusableChars).toBe(reusable);
    expect(observation.interleavedBy).toEqual([
      { kind: 'trusted-runtime', consumerContract: 'nestor-v1', taskType: null },
      { kind: 'classifier', consumerContract: null, taskType: null },
    ]);

    // Ollama evaluated the whole prompt again: the lost share of its prefill
    // is the reusable prefix over everything evaluated.
    const verdict = promptCacheVerdict(observation, { loadMs: 40, promptEvalMs: 3_000 });
    expect(verdict).toMatchObject({ verdict: 'interleaved', lostChars: reusable });
    expect(verdict.lostPrefillMs).toBe(Math.round(3_000 * reusable / charsOf(next)));
    expect(JSON.stringify(verdict)).not.toContain(SECRET);
    expect(JSON.stringify(verdict)).not.toContain('question');
  });

  test('a shared system prompt stays reusable across callers; only the rest is lost', () => {
    const { call } = setup();
    const sameSystem = (user) => ({ model: MODEL, messages: [
      { role: 'system', content: system('household') }, { role: 'user', content: user },
    ] });
    call(sameSystem('first person, long question '.repeat(20)), { kind: 'chat' });
    call(sameSystem('second person'), { kind: 'chat' });
    const followUp = { model: MODEL, messages: [
      ...sameSystem('first person, long question '.repeat(20)).messages,
      { role: 'assistant', content: 'answer' }, { role: 'user', content: 'and then?' },
    ] };
    const observation = call(followUp, { kind: 'chat' });
    const systemChars = charsOf({ messages: [{ role: 'system', content: system('household') }] });
    expect(observation.sharedChars).toBe(systemChars);
    expect(observation.reusableChars).toBeGreaterThan(systemChars);
    expect(promptCacheVerdict(observation, { promptEvalMs: 100 }))
      .toMatchObject({ verdict: 'interleaved', lostChars: observation.reusableChars - systemChars });
  });

  test('a reload loses the whole reusable prefix, interleaved or not', () => {
    const { call } = setup();
    call(conversation('coder', 1));
    const observation = call(conversation('coder', 2));
    const verdict = promptCacheVerdict(observation, { loadMs: RELOAD_LOAD_MS + 4_000, promptEvalMs: 1_000 });
    expect(verdict).toMatchObject({ verdict: 'reload', lostChars: observation.reusableChars });
    expect(verdict.lostPrefillMs).toBe(Math.round(1_000 * observation.reusableChars / observation.chars));
  });

  test('nothing reusable is cold, and an unmeasured prefill leaves the lost time unknown', () => {
    const { call } = setup();
    call(conversation('coder', 1));
    const unrelated = call({ model: MODEL, prompt: 'Summarise the weather.' }, { kind: 'prompt-analysis' });
    expect(promptCacheVerdict(unrelated, { loadMs: 9_000 })).toMatchObject({ verdict: 'cold', lostChars: 0, lostPrefillMs: null });
    const back = call(conversation('coder', 2));
    expect(promptCacheVerdict(back)).toMatchObject({ verdict: 'interleaved', lostPrefillMs: null });
  });

  test('each host and model keeps its own history, bounded', () => {
    const { call } = setup({ history: 2, maxTargets: 1 });
    call(conversation('coder', 1));
    expect(call(conversation('coder', 2), {}, { model: 'other-model' })).toMatchObject({ tracked: false });
    // The other model evicted the first target.
    expect(call(conversation('coder', 2))).toMatchObject({ tracked: false });
    call({ model: MODEL, prompt: 'one' });
    call({ model: MODEL, prompt: 'two' });
    // Only the last two requests are compared: the coder turn is forgotten.
    expect(call(conversation('coder', 3))).toMatchObject({ tracked: true, reusableChars: 0 });
  });

  test('embeddings and bare loads are not observed', () => {
    const { call } = setup();
    expect(call({ model: MODEL, input: ['text'] })).toBeNull();
    expect(call({ model: MODEL, prompt: '' })).toBeNull();
    expect(call({ model: MODEL, messages: [] })).toBeNull();
    expect(call(conversation('coder', 0))).toMatchObject({ tracked: false });
  });

  test('a generate prompt is compared by paragraph', () => {
    const { call } = setup();
    call({ model: MODEL, system: 'Judge.', prompt: 'Rubric.\n\nAnswer A.\n\nScore it.' });
    const observation = call({ model: MODEL, system: 'Judge.', prompt: 'Rubric.\n\nAnswer B.\n\nScore it.' });
    expect(observation.sharedChars).toBe('Judge.'.length + 'Rubric.\n\n'.length);
  });

  test('read and write keep labels and counts only', () => {
    expect(sanitizePromptCache({ verdict: 'unknown' })).toBeNull();
    expect(sanitizePromptCache({
      verdict: 'interleaved', chars: 10, sharedChars: 2, reusableChars: 8, lostChars: 6, lostPrefillMs: 30,
      sincePreviousMs: 5, interleaved: 1, prompt: SECRET,
      interleavedBy: [{ kind: 'chat', consumerContract: 'has spaces', taskType: 'x'.repeat(80), text: SECRET }],
    })).toEqual({
      verdict: 'interleaved', chars: 10, sharedChars: 2, reusableChars: 8, lostChars: 6, lostPrefillMs: 30,
      sincePreviousMs: 5, interleaved: 1,
      interleavedBy: [{ kind: 'chat', consumerContract: null, taskType: null }],
    });
    expect(promptCacheVerdict({ tracked: true, chars: 10, sharedChars: 50, reusableChars: 99 }))
      .toMatchObject({ sharedChars: 10, reusableChars: 10, verdict: 'warm' });
  });
});
