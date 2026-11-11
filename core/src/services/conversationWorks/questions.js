'use strict';
const { hash, fail, notFound } = require('./contract');
const { uuid, exactKeys, ordinary, basisFor, answersFor, bindingMatches, invalid, unavailable } = require('./question-contract');
const open = row => row?.mode === 'native' && !row.erased && !row.result && row.attempt?.id && row.attempt?.runId
  && ['running', 'dispatching', 'uncertain'].includes(row.state);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function createWorkQuestions({ works, runtime, now = () => Date.now() }) {
  const { repo } = works;
  async function bound(id, sessionId) {
    const row = await repo.get(id);
    if (!row || sessionId && row.sessionId !== sessionId || row.mode !== 'native' || !row.attempt?.runId
        || await works.requestTextForDisplay(row) === null) throw notFound();
    return row;
  }
  async function context(input) {
    if (!exactKeys(input, ['workId']) || !/^[a-f0-9]{64}$/.test(input.workId || '')) throw invalid();
    const row = await bound(input.workId);
    if (!runtime) throw unavailable();
    if (!open(row)) throw notFound();
    return { authority: 'core.conversation-works', workId: row._id, action: 'observe',
      attempt: { id: row.attempt.id, agentId: row.attempt.agentId, sessionKey: row.attempt.sessionKey, runId: row.attempt.runId } };
  }
  async function observe(row, signal) {
    let evidence;
    try { evidence = await runtime?.observe(row, { signal }); } catch { evidence = null; }
    const capable = evidence?.contract === 1 && Array.isArray(evidence.questions) && evidence.questions.length <= 64;
    const matching = capable ? evidence.questions.filter(q => q?.agentId === row.attempt.agentId
      && q.sessionKey === row.attempt.sessionKey && q.runId === row.attempt.runId) : [];
    const records = matching.map(record => ordinary(record, row.attempt)).filter(Boolean);
    const supported = capable && evidence.blocked !== true && records.length === matching.length && records.length <= 3;
    const observations = (supported ? records : []).map(question => ({ question, basis: basisFor(row, question) }));
    await repo.mutate(row._id, async (current, fence) => {
      if (!open(current) || current.attempt.id !== row.attempt.id || current.attempt.runId !== row.attempt.runId
          || current.requestSha256 !== row.requestSha256) return null;
      const previous = current.nativeQuestions || { observations: [], intents: [] };
      if (!supported) return previous.supported === false ? null : { fields: { nativeQuestions: { ...previous, supported: false } }, event: 'native_questions_unavailable' };
      if (previous.supported === supported && same(previous.observations.map(o => o.basis), observations.map(o => o.basis))) return null;
      const saved = [];
      for (const { question, basis } of observations) {
        const earlier = previous.observations.find(o => o.basis.questionSha256 === basis.questionSha256);
        saved.push(earlier || { basis, expiresAtMs: question.expiresAtMs,
          requestSha256: current.requestSha256, attemptId: current.attempt.id,
          sessionKey: current.attempt.sessionKey, runId: current.attempt.runId,
          payloadRef: await repo.payload(current, question, fence) });
      }
      return { fields: { nativeQuestions: { ...previous, supported, observations: saved } }, event: 'native_questions_observed' };
    });
  }
  async function receive(id, intentId, result) {
    return repo.mutate(id, async current => {
      const state = current.nativeQuestions, intent = state?.intents.find(i => i.id === intentId);
      if (!intent || !bindingMatches(current, intent.binding) || ['answered', 'expired', 'cancelled', 'mismatch'].includes(intent.state)) return null;
      // An unrelated or unbound receipt can never confirm this human decision.
      let nextState = intent.state === 'accepted' ? 'accepted' : 'unknown';
      if (result?.contract === 1 && result.incarnation === intent.basis.incarnation) {
        if (result.status === 'answered' && result.resolutionId === intent.resolutionId) {
          const payload = await repo.read(current, intent.payloadRef);
          if (payload && same(result.answers, payload.answers)) nextState = 'answered';
        } else if (['expired', 'cancelled'].includes(result.status)) nextState = result.status;
      } else if (result?.contract === 1 && result.status === 'mismatch') nextState = 'mismatch';
      if (intent.state === nextState) return null;
      return { fields: { nativeQuestions: { ...state, intents: state.intents.map(i => i.id === intentId ? { ...i, state: nextState } : i) } },
        event: 'native_question_' + nextState, eventData: { requestId: intentId } };
    });
  }
  async function transport(id, intentId, lookupOnly, signal) {
    let result;
    try { result = await runtime?.effect({ workId: id, intentId, lookupOnly }, { signal }); } catch { result = null; }
    try { await receive(id, intentId, result); }
    catch (cause) { if (cause.code !== 'CONVERSATION_WORK_NOT_FOUND' && cause.code !== 'CONVERSATION_CONTENT_ERASED') throw cause; }
  }
  async function refresh(sessionId) {
    await works.session(sessionId); // Reject other surfaces before any native call.
    if (!runtime) return;
    const signal = AbortSignal.timeout(1200);
    const active = await repo.find({ sessionId, mode: 'native', result: null,
      state: { $in: ['running', 'dispatching', 'uncertain'] }, 'attempt.runId': { $exists: true } }, 64);
    for (const row of active) {
      if (signal.aborted) break;
      try { await observe(row, signal); }
      catch (cause) { if (cause.code !== 'CONVERSATION_WORK_NOT_FOUND' && cause.code !== 'CONVERSATION_CONTENT_ERASED') throw cause; }
    }
    // Completed history must never crowd out the current native question.
    // Reconcile a bounded recent set separately; any original intent also has
    // its exact lookup route, independently of this periodic read selection.
    const pending = await repo.find({ sessionId, mode: 'native',
      'nativeQuestions.intents': { $elemMatch: { state: { $in: ['accepted', 'dispatched', 'unknown'] } } } },
    64, { updatedAt: -1, _id: 1 });
    for (const row of pending) for (const intent of row.nativeQuestions.intents) {
      if (signal.aborted) return;
      if (['accepted', 'dispatched', 'unknown'].includes(intent.state)) await transport(row._id, intent.id, true, signal);
    }
  }
  async function projection(row) {
    const state = row.nativeQuestions;
    if (!state) return null;
    const questions = [];
    for (const observation of state.observations) {
      if (!bindingMatches(row, observation)) continue;
      const question = await repo.read(row, observation.payloadRef);
      if (!question) continue;
      const intent = state.intents.find(i => i.basis.questionSha256 === observation.basis.questionSha256);
      questions.push({ basis: observation.basis, questions: question.questions, expiresAtMs: question.expiresAtMs,
        answerable: Boolean(runtime) && open(row) && state.supported && !intent && now() < question.expiresAtMs,
        ...(intent && { intent: { requestId: intent.id, state: intent.state, resolutionId: intent.resolutionId } }) });
    }
    return { supported: Boolean(runtime) && state.supported, questions,
      intents: state.intents.map(i => ({ requestId: i.id, questionSha256: i.basis.questionSha256, state: i.state, resolutionId: i.resolutionId })) };
  }
  async function history(row) {
    const decisions = [];
    for (const intent of row.nativeQuestions?.intents || []) {
      const payload = await repo.read(row, intent.payloadRef);
      if (!payload) throw fail('CONVERSATION_WORK_CONTEXT_UNAVAILABLE', 'The retained question decision is unavailable.', 503);
      decisions.push({ source: 'explicit_surface_form', requestId: intent.id,
        requestSha256: intent.basis.requestSha256, questionSha256: intent.basis.questionSha256,
        questions: payload.question.questions, answers: payload.answers, nativeOutcome: intent.state });
    }
    return decisions;
  }
  async function submit(sessionId, id, input) {
    await works.session(sessionId);
    if (!exactKeys(input, ['basis', 'requestId', 'answers']) || !uuid(input.requestId)
        || !exactKeys(input.basis, ['version', 'workId', 'requestSha256', 'attemptId', 'questionId', 'incarnation', 'questionSha256'])
        || input.basis.version !== 1 || input.basis.workId !== id) throw invalid();
    const fingerprint = hash(JSON.stringify([input.basis, input.answers]));
    await bound(id, sessionId);
    await repo.mutate(id, async (current, fence) => {
      if (current.sessionId !== sessionId) throw notFound();
      const state = current.nativeQuestions;
      const previous = state?.intents.find(i => i.id === input.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw fail('CONVERSATION_QUESTION_INTENT_CONFLICT', 'This answer identity belongs to a different decision.', 409);
        return null;
      }
      const observation = state?.observations.find(o => same(o.basis, input.basis));
      if (!open(current) || !state?.supported || !runtime || !observation || !bindingMatches(current, observation)
          || now() >= observation.expiresAtMs || await works.requestTextForDisplay(current) === null) throw unavailable();
      if (state.intents.length >= 64 || state.intents.some(i => i.basis.questionSha256 === observation.basis.questionSha256)) {
        throw fail('CONVERSATION_QUESTION_INTENT_HELD', 'This question already has a retained decision. Read its original outcome.', 409);
      }
      const question = await repo.read(current, observation.payloadRef);
      if (!question) throw unavailable();
      const answers = answersFor(question.questions, input.answers);
      const intent = { id: input.requestId, fingerprint, resolutionId: input.requestId, state: 'accepted', basis: observation.basis,
        binding: { ...observation }, payloadRef: await repo.payload(current, { question, answers }, fence) };
      return { fields: { nativeQuestions: { ...state, intents: [...state.intents, intent] } },
        event: 'native_question_intent_accepted', eventData: { requestId: intent.id } };
    });
    // The adapter consumes the stored intent. Duplicate triggers may only lookup
    // after its one durable effect admission, never resend the native resolution.
    await transport(id, input.requestId, false);
    return lookup(sessionId, id, input.requestId, false);
  }
  async function claim(input) {
    if (!exactKeys(input, ['workId', 'intentId', 'lookupOnly']) || !uuid(input.intentId) || typeof input.lookupOnly !== 'boolean') throw invalid();
    const initial = await bound(input.workId);
    const snapshot = initial.nativeQuestions?.intents.find(i => i.id === input.intentId);
    if (!snapshot) throw notFound();
    let packet;
    await repo.mutate(input.workId, async current => {
      const state = current.nativeQuestions, intent = state?.intents.find(i => i.id === input.intentId);
      if (!intent || !bindingMatches(current, intent.binding)) throw notFound();
      const payload = await repo.read(current, intent.payloadRef);
      if (!payload) throw notFound();
      if (intent.state === 'accepted' && (!runtime || !state.supported)) throw unavailable();
      const dispatch = !input.lookupOnly && intent.state === 'accepted';
      if (dispatch && (!open(current) || now() >= payload.question.expiresAtMs || await works.requestTextForDisplay(current) === null)) throw unavailable();
      packet = { authority: 'core.conversation-works', workId: current._id, intentId: intent.id,
        action: dispatch ? 'resolve' : 'lookup', resolutionId: intent.resolutionId,
        question: payload.question, ...(dispatch && { answers: payload.answers }) };
      return dispatch ? { fields: { nativeQuestions: { ...state,
        intents: state.intents.map(i => i.id === intent.id ? { ...i, state: 'dispatched' } : i) } },
      event: 'native_question_effect_admitted', eventData: { requestId: intent.id } } : null;
    });
    return packet;
  }
  async function resume(sessionId, id, intentId, input) {
    await works.session(sessionId);
    if (!uuid(intentId) || !exactKeys(input, [])) throw invalid();
    const row = await bound(id, sessionId);
    const intent = row.nativeQuestions?.intents.find(i => i.id === intentId);
    if (!intent) throw notFound();
    if (intent.state !== 'accepted') throw fail('CONVERSATION_QUESTION_ALREADY_ADMITTED',
      'This decision may already have reached its owner. Read its original outcome.', 409);
    // Explicit recovery of an existing, never-admitted intent. The adapter's
    // atomic claim still decides resolve vs lookup if another caller races us.
    await transport(id, intentId, false);
    return lookup(sessionId, id, intentId, false);
  }
  async function lookup(sessionId, id, intentId, readNative = true) {
    await works.session(sessionId);
    if (!uuid(intentId)) throw invalid();
    const row = await bound(id, sessionId);
    if (!row.nativeQuestions?.intents.some(i => i.id === intentId)) throw notFound();
    if (readNative) await transport(id, intentId, true);
    const saved = await bound(id, sessionId);
    return { authority: 'core.conversation-works', workId: id,
      intent: (await projection(saved)).intents.find(i => i.requestId === intentId) };
  }
  return { context, refresh, projection, history, submit, claim, resume, lookup, receive };
}
module.exports = { createWorkQuestions };
