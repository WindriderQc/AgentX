'use strict';

// Consume Core's admitted NDJSON stream and wait for the host-release receipt.
// A disconnected caller suppresses content while Core still drains its attempt.
async function readAdmittedInferenceStream(result, { signal, onToken = () => {}, onThinking = () => {}, maxContentChars = 50000 } = {}) {
  if (!result?.ok || !result.stream || typeof result.completion?.then !== 'function') throw new Error('Admitted inference stream is unavailable');
  const decoder = new TextDecoder();
  let pending = '', content = '', thinkingObserved = false, terminal = null;
  const consume = line => {
    if (!line.trim()) return;
    const row = JSON.parse(line);
    if (row.error) throw new Error(typeof row.error === 'string' ? row.error : 'Inference failed');
    if (signal?.aborted) return;
    const token = row.message?.content || row.response || '';
    const thinking = row.message?.thinking || row.thinking || '';
    if (token) {
      if (content.length + token.length > maxContentChars) throw new Error('Inference response exceeds the conversation limit');
      content += token; onToken(token);
    }
    if (thinking) { thinkingObserved = true; onThinking(thinking); }
    if (row.done === true) terminal = row;
  };
  let readError;
  try {
    for await (const chunk of result.stream) {
      pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (pending.length > 2 * 1024 * 1024) throw new Error('Inference stream record exceeds the limit');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) consume(pending);
  } catch (error) { readError = error; }
  await result.completion;
  if (readError) throw readError;
  if (signal?.aborted) throw Object.assign(new Error('Inference cancelled'), { name: 'AbortError' });
  if (!terminal) throw new Error('Inference stream ended before completion');
  return { content, thinkingObserved, stats: terminal, model: terminal.model || result.metadata?.model || null };
}

module.exports = { readAdmittedInferenceStream };
