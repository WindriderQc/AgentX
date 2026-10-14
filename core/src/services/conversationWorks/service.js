'use strict';

const { randomUUID } = require('node:crypto');
const exchanges = require('../conversations/exchangeReceipts');
const { OWNER, SCOPED, EXCHANGE_SCOPE, ACTIVE, LIMITS, hash, fail, notFound,
  MODES, nativeWork, simple, eligible, sessionScope, validateResult } = require('./contract');
const { createRepository } = require('./repository');
const { readTurnContext, assertContextSize } = require('../conversations/turnContext');

function createConversationWorks({ conversations, tasks, env = process.env, repository = createRepository(), classify = () => false, nativeOnly = () => false, nativeRead = () => false,
  nativeBudget = () => null, nativeForeground = () => true, guardianNeedsMain = () => false,
  presentResult = null, exchangeStore = exchanges, now = () => new Date() } = {}) {
  const repo = repository;
  let wake = () => {};
  const classification = (text, mode) => mode === 'native' ? simple(text) || !nativeForeground(text) ? 'native_review' : 'native_work'
    : mode === 'read' && nativeRead(text) ? 'native_read'
    : classify(text) ? 'tasks_read' : nativeOnly(text) ? 'native_only' : 'unclassified';
  const query = sessionId => ({ sessionId, ...SCOPED });
  async function session(sessionId) {
    const value = await conversations.getSession(query(sessionId));
    if (!sessionScope(value) || value.status !== 'active') throw notFound();
    return value;
  }
  async function retained(current, turnId, channel = 'voice') {
    if (!sessionScope(current) || channel !== 'voice' || (current.agentId && current.agentId !== 'main')
        || current.backend !== 'openclaw' || current.inference?.open || current.llmx
        || !/^[a-zA-Z0-9-]{16,80}$/.test(turnId || '')) return null;
    const row = await repo.get(hash(current.sessionId + '\n' + turnId));
    if (row) return row;
    const receipt = await exchangeStore.read(EXCHANGE_SCOPE, hash(EXCHANGE_SCOPE + '\n' + turnId));
    return receipt?.request?.body?.sessionId === current.sessionId && MODES.includes(receipt.request.body.mode)
      ? { mode: receipt.request.body.mode } : null;
  }
  async function intake({ session: current, turnId, text, attachments = [], channel = 'voice', speechLanguage }) {
    const previousWork = await retained(current, turnId, channel);
    if (!eligible(current, channel, env) && !previousWork) return null;
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(turnId || '') || typeof text !== 'string' || !text.trim() || text.length > LIMITS.request) {
      throw fail('CONVERSATION_WORK_INTAKE_INVALID', 'A stable turn identity and complete request are required.');
    }
    const id = hash(current.sessionId + '\n' + turnId);
    const snapshot = { text, attachments, sessionId: current.sessionId, channel, clientTurnId: turnId,
      mode: previousWork?.mode || env.PERSONAL_CONVERSATION_WORK_MODE };
    const accepted = await exchangeStore.accept(EXCHANGE_SCOPE, { body: snapshot }, turnId, current.conversationId);
    const taken = await conversations.acceptTurn({ ...query(current.sessionId), modeId: current.modeId,
      traceId: turnId, clientTurnId: turnId, channel, inputText: text, attachments,
      ...(['fr', 'en'].includes(speechLanguage) && { speechLanguage }) });
    const previous = await repo.get(id);
    if (previous) return { row: previous, turn: taken.turn, duplicate: true };
    if ((await repo.find({ state: { $in: ACTIVE } }, LIMITS.open + 1)).length >= LIMITS.open) {
      throw fail('CONVERSATION_WORK_CAPACITY', 'The request is retained, but too many works are still open.', 503);
    }
    const at = now();
    const guardianAgentId = !accepted.duplicate && snapshot.mode === 'native'
      && /^[a-z][a-z0-9_-]{0,63}$/.test(env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID || '')
      && !['main', 'family', env.PERSONAL_CONVERSATION_WORK_AGENT_ID].includes(env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID)
      ? env.PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID : 'main';
    const row = await repo.insert({ _id: id, owner: OWNER, surface: 'household',
      conversationId: current.conversationId, sessionId: current.sessionId, turnId,
      exchangeId: accepted.receipt._id, requestSha256: hash(text), mode: snapshot.mode,
      state: 'received', classification: classification(text, snapshot.mode),
      revision: 0, receivedAt: at, updatedAt: at, contextReady: false, tools: [], events: [], sequence: 0,
      ...(snapshot.mode === 'native' && { foreground: nativeForeground(text) && !simple(text) ? 'acknowledge' : 'guardian' }),
      guardian: { agentId: guardianAgentId, ...(guardianAgentId !== 'main' && { sessionId: randomUUID() }),
        state: accepted.duplicate ? taken.turn.outcome === 'pending' ? 'uncertain' : 'completed' : 'pending' }, erased: false });
    return { row, turn: taken.turn, duplicate: accepted.duplicate || taken.duplicate };
  }
  async function prepare(id, context) {
    if (typeof context !== 'string' || context.length > LIMITS.context) throw fail('CONVERSATION_WORK_CONTEXT_REQUIRED', 'The selected context exceeds the work budget.', 409);
    const row = await repo.mutate(id, async (current, fence) => current.contextReady ? null : {
      fields: { contextReady: true, contextRef: await repo.payload(current, { selectedContext: context }, fence),
        state: current.state === 'received' && ['tasks_read', 'native_read', 'native_work'].includes(current.classification) ? 'queued' : current.state }, event: 'context_ready' });
    wake(); return row;
  }
  const guardianStarted = (id, sessionKey, runId, agentId = 'main') => repo.mutate(id, current => {
    if (agentId !== (current.guardian?.agentId || 'main') || !sessionKey?.startsWith(`agent:${agentId}:household:direct:`)
        || current.guardian?.sessionId && sessionKey !== `agent:${agentId}:household:direct:${current.guardian.sessionId}`
        || !/^resp_[a-f0-9-]{36}$/.test(runId || '')
        || current.guardian?.runId && (current.guardian.runId !== runId || current.guardian.sessionKey !== sessionKey)) throw notFound();
    return { fields: { guardian: { ...current.guardian, agentId, state: 'running', sessionKey, runId } }, event: 'guardian_started' };
  });
  const guardianSettled = async (id, state, disposition) => {
    if (disposition !== undefined && !['answered', 'awaiting_main'].includes(disposition)) {
      throw fail('CONVERSATION_WORK_GUARDIAN_DISPOSITION_INVALID', 'A native guardian disposition is required.');
    }
    const row = await repo.mutate(id, current => {
      // Recovery can mark a long native consultation uncertain before its
      // original guardian returns. Its exact settlement still owns that intake.
      const nativeIntake = current.classification === 'native_only' && ['received', 'uncertain'].includes(current.state)
        && !current.attempt && !current.result;
      const interruptedReview = current.classification === 'native_review' && state === 'cancelled';
      const nextState = nativeIntake ? state : current.state === 'received' && !['native_only', 'native_read', 'native_work'].includes(current.classification)
        ? state === 'cancelled' && !interruptedReview ? 'cancelled' : current.contextReady ? 'queued' : current.state : current.state;
      const awaiting = state === 'completed' && disposition === 'awaiting_main' && current.mode === 'native';
      return { fields: { guardian: { ...current.guardian, state, ...(disposition && { disposition }) }, state: nextState,
        ...(awaiting && current.classification === 'native_review' && { classification: 'native_work', foreground: 'acknowledge' }),
        ...(nativeIntake && { reason: '' }) }, event: 'guardian_settled' };
    });
    if (['completed', 'failed', 'cancelled'].includes(row.state)) await finalize(row);
    wake(); return row;
  };
  async function binding(context, role = 'worker') {
    if (!context || Object.keys(context).some(key => !['agentId', 'sessionKey', 'runId'].includes(key))
      || !/^resp_[a-f0-9-]{36}$/.test(context.runId || '')) throw notFound();
    const rows = await repo.find(role !== 'guardian'
      ? { 'attempt.sessionKey': context.sessionKey }
      : { 'guardian.sessionKey': context.sessionKey, 'guardian.runId': context.runId }, 1);
    let row = rows[0];
    const identity = role !== 'guardian' ? row?.attempt : row?.guardian;
    const expected = role !== 'guardian' ? row?.attempt?.agentId : row?.guardian?.agentId || 'main';
    if (!row || context.agentId !== expected || !identity || identity.sessionKey !== context.sessionKey
      || (identity.runId && identity.runId !== context.runId)) throw notFound();
    await session(row.sessionId);
    if (role === 'boss' && (row.mode !== 'native' || !nativeWork(row) || context.agentId !== 'main'
        || !['running', 'dispatching', 'uncertain'].includes(row.state))) throw notFound();
    if (role === 'worker' && (nativeWork(row) || !row.attempt || ['failed', 'cancelled'].includes(row.state))) throw notFound();
    if (role !== 'guardian' && !identity.runId) row = await repo.mutate(row._id, current => {
      if (current.attempt?.runId && current.attempt.runId !== context.runId) throw notFound();
      return { fields: { attempt: { ...current.attempt, runId: context.runId }, state: 'running' }, event: 'native_observed' };
    });
    if (role !== 'guardian' && row.state === 'uncertain') row = await repo.mutate(row._id, current => ({
      fields: { state: current.result ? 'result_ready' : 'running' }, event: 'native_call_observed' }));
    return row;
  }
  async function request(context) {
    const row = await binding(context, 'guardian');
    if (!['read', 'native'].includes(row.mode)) throw fail('CONVERSATION_WORK_OBSERVE_ONLY', 'Observation mode cannot accept a tool lookup.', 409);
    const updated = await repo.mutate(row._id, current => {
      if (current.result || ['failed', 'cancelled', 'completed'].includes(current.state)) {
        return null;
      }
      if (current.mode === 'native' || current.classification === 'tasks_read') return null;
      return { fields: { classification: 'tasks_read', state: current.contextReady && current.state === 'received' ? 'queued' : current.state }, event: 'read_requested' };
    });
    if (updated.state === 'completed' && !updated.result) throw fail('CONVERSATION_WORK_ALREADY_HANDLED', 'This turn is already handled. No lookup was queued.', 409);
    wake(); return { authority: 'core.conversation-works', accepted: true, id: updated._id,
      turnId: updated.turnId, state: updated.state, execution: updated.result ? 'completed' : ['failed', 'cancelled'].includes(updated.state) ? updated.state : 'pending',
      result: updated.result ? { version: updated.result.version, deliveryId: updated.delivery.id } : null };
  }
  async function contextForWorker(context, role = 'worker') {
    const row = await binding(context, role);
    const turn = await conversations.getTurn({ ...query(row.sessionId), traceId: row.turnId });
    if (!turn || hash(turn.inputText) !== row.requestSha256) throw fail('CONVERSATION_WORK_CONTEXT_UNAVAILABLE', 'The complete canonical request is unavailable.', 503);
    const selected = row.contextRef ? await repo.read(row, row.contextRef) : { selectedContext: '' };
    const conversation = await conversationContext(row.sessionId);
    assertContextSize(selected.selectedContext + JSON.stringify(conversation), LIMITS.context);
    return { authority: 'core.conversation-works', id: row._id, turnId: row.turnId,
      request: turn.inputText, guardianReply: turn.replyText, guardianOutcome: turn.outcome,
      guardianDisposition: row.mode === 'native' && guardianNeedsMain(turn.replyText) ? 'awaiting_main' : row.guardian?.disposition || 'unknown',
      guardianEvidence: turn.toolEvidence ? { authority: turn.toolEvidence.authority, runId: turn.toolEvidence.runId,
        status: turn.toolEvidence.status, receipts: turn.toolEvidence.receipts || [] } : null, selectedContext: selected.selectedContext,
      attachments: turn.attachments || [], mode: row.mode, classification: row.classification,
      ...(role === 'worker' && { capabilities: row.mode === 'read' ? ['tasks.personal.list'] : [] }),
      ...(role === 'boss' && { nativeOwner: 'main', workContext: await guardianContext(row.sessionId, row._id) }),
      conversation,
      receiptIds: row.tools.map(item => item.id) };
  }
  async function conversationContext(sessionId) {
    await session(sessionId);
    const conversation = await readTurnContext(conversations, query(sessionId));
    const turns = new Map(conversation.turns.map(turn => [turn.turnId, turn]));
    // Published background answers are part of Nestor's dialogue even though
    // they do not replace the guardian's immutable assistant slot. No UI or
    // guardian-feedback window limits this trusted context read (Mongo limit 0).
    const rows = await repo.find({ sessionId, 'result.version': { $exists: true }, 'result.kind': { $ne: 'no_work' } }, 0);
    for (const row of rows) {
      const turn = turns.get(row.turnId);
      if (!turn) throw fail('CONVERSATION_WORK_CONTEXT_UNAVAILABLE', 'A background answer has no canonical conversation turn.', 503);
      const result = await repo.read(row, row.result.payloadRef);
      const evidence = [];
      for (const tool of row.tools) evidence.push({ id: tool.id, tool: tool.tool, status: tool.status,
        runId: tool.runId, data: await repo.read(row, tool.payloadRef) });
      (turn.workResults ||= []).push({ authority: 'core.conversation-works', workId: row._id,
        version: row.result.version, publishedAt: row.result.publishedAt, kind: result.kind, text: result.text,
        receiptIds: result.receiptIds, toolEvidence: evidence,
        presentation: { state: row.delivery?.state || 'unknown',
          receipts: (row.delivery?.receipts || []).map(({ stage, at }) => ({ stage, at })) } });
    }
    conversation.coverage.workResultCount = rows.length;
    return conversation;
  }
  async function readTasks(context, input, callId) {
    const row = await binding(context);
    if (row.mode !== 'read' || !['running', 'dispatching'].includes(row.state)) throw fail('CONVERSATION_WORK_READ_DENIED', 'This work cannot read tasks.', 403);
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(callId || '') || !input || Object.keys(input).some(key => !['limit', 'includeDone'].includes(key))
      || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50))
      || (input.includeDone !== undefined && typeof input.includeDone !== 'boolean')) throw fail('CONVERSATION_WORK_READ_INVALID', 'Choose a bounded task read.');
    const normalized = { limit: input.limit ?? 25, includeDone: input.includeDone ?? false };
    const id = hash(row.attempt.id + '\n' + callId), fingerprint = hash(JSON.stringify(normalized));
    const saved = await repo.mutate(row._id, async (current, fence) => {
      if (!['running', 'dispatching'].includes(current.state) || current.attempt?.runId !== context.runId) throw notFound();
      const previous = current.tools.find(tool => tool.id === id);
      if (previous) { if (previous.fingerprint !== fingerprint) throw fail('CONVERSATION_WORK_TOOL_CONFLICT', 'The tool identity belongs to other parameters.', 409); return null; }
      if (current.tools.length >= LIMITS.tools) throw fail('CONVERSATION_WORK_TOOL_LIMIT', 'The read budget is exhausted.', 409);
      const result = await tasks.list(normalized);
      if (!result || !Array.isArray(result.tasks) || !Number.isInteger(result.totalCount) || result.totalCount < result.tasks.length) throw fail('CONVERSATION_WORK_READ_UNAVAILABLE', 'The Core task read returned no verified task list.', 503);
      const payloadRef = await repo.payload(current, result, fence);
      return { fields: { tools: [...current.tools, { id, tool: 'tasks.personal.list',
        fingerprint, payloadRef, runId: context.runId, callId, at: now(), status: 'verified' }] }, event: 'tool_result' };
    });
    const receipt = saved.tools.find(tool => tool.id === id);
    return { authority: 'core.conversation-works', receipt: { id, tool: receipt.tool, status: 'verified',
      runId: receipt.runId, at: receipt.at }, data: await repo.read(saved, receipt.payloadRef) };
  }
  async function publish(context, input) {
    const row = await binding(context), result = validateResult(input);
    if (result.targetTurnId && result.targetTurnId !== row.turnId) throw notFound();
    if (row.mode === 'read' && row.classification === 'tasks_read' && (!result.receiptIds.length || result.kind === 'no_work')) {
      throw fail('CONVERSATION_WORK_RECEIPT_REQUIRED', 'A requested task lookup requires its actual Core receipt.', 409);
    }
    if (result.receiptIds.some(id => !row.tools.some(tool => tool.id === id && tool.status === 'verified'))) throw fail('CONVERSATION_WORK_RECEIPT_INVALID', 'A receipt is not owned by this work.', 409);
    const fingerprint = hash(JSON.stringify(result));
    const saved = await repo.mutate(row._id, async (current, fence) => {
      if (current.result) { if (current.result.fingerprint !== fingerprint) throw fail('CONVERSATION_WORK_RESULT_CONFLICT', 'The result was already published.', 409); return null; }
      if (!['running', 'dispatching', 'uncertain'].includes(current.state) || current.attempt?.runId !== context.runId) throw notFound();
      if (current.classification === 'tasks_read' && current.mode === 'read' && (!result.receiptIds.length || result.kind === 'no_work')) throw fail('CONVERSATION_WORK_RECEIPT_REQUIRED', 'A requested lookup requires its Core receipt.', 409);
      if (result.receiptIds.some(id => !current.tools.some(tool => tool.id === id && tool.status === 'verified'))) throw fail('CONVERSATION_WORK_RECEIPT_INVALID', 'A receipt is not owned by this work.', 409);
      return { fields: { result: { version: 1, kind: result.kind, fingerprint,
        payloadRef: await repo.payload(current, result, fence), publishedAt: now() }, state: 'result_ready',
        delivery: { id: randomUUID(), resultVersion: 1, state: 'available', receipts: [] } }, event: 'result_published' };
    });
    return { authority: 'core.conversation-works', published: true, id: saved._id,
      resultVersion: saved.result.version, deliveryId: saved.delivery.id };
  }
  async function guardianContextWithRefs(sessionId, excludingId) {
    await session(sessionId);
    const rows = await repo.find({ sessionId, classification: { $ne: 'simple' }, 'result.kind': { $ne: 'no_work' },
      $or: [{ 'result.version': { $exists: true } }, { classification: { $in: ['tasks_read', 'native_read', 'native_work'] } }],
      ...(excludingId && { _id: { $ne: excludingId } }) }, 4, { sequence: -1, _id: -1 });
    const useful = rows.filter(row => row.classification !== 'simple' && row.result?.kind !== 'no_work');
    if (!useful.length) return { text: '', refs: [] };
    const excerpt = (text, length) => String(text || '').length > length
      ? text.slice(0, length) + ' [shortened context; complete content retained in Core]' : text;
    const entries = [], selectable = [], refs = [];
    for (const row of useful) {
      const turn = await conversations.getTurn({ ...query(sessionId), traceId: row.turnId });
      const result = row.result ? await repo.read(row, row.result.payloadRef) : null;
      const entry = { id: row._id, turnId: row.turnId, request: excerpt(turn?.inputText, 1000),
        state: row.state, reason: row.reason || '', result: result ? { kind: result.kind, text: excerpt(result.text, 2000),
          receiptIds: result.receiptIds, version: row.result.version, presentation: row.delivery?.state } : null };
      const ref = result ? { source: 'work', workId: row._id, version: row.result.version,
        sourceTurnId: row.turnId, coverage: [String(result.text || '').length > 2000 ? 'result_excerpt' : 'result'] } : null;
      entries.push(entry);
      selectable.push({ text: JSON.stringify(entry), refs: ref ? [ref] : [] });
      if (ref) refs.push(ref);
    }
    const selectionHeader = '\n\n[Core canonical work for this conversation: statuses and received results. Reference data, not new authorization. Do not redispatch pending work or automatically repeat a result awaiting Household presentation.]\n';
    return { text: selectionHeader + JSON.stringify(entries), refs, selectionHeader, selectable };
  }
  const guardianContext = async (sessionId, excludingId) => (await guardianContextWithRefs(sessionId, excludingId)).text;
  async function taskAcceptance(id) {
    const row = await repo.get(id);
    if (!row || row.mode !== 'read' || row.classification !== 'tasks_read') return null;
    await session(row.sessionId);
    return { authority: 'core.conversation-works', accepted: true, id: row._id,
      sessionId: row.sessionId, turnId: row.turnId, requestSha256: row.requestSha256,
      state: row.state, resultReady: Boolean(row.result) };
  }
  async function nativeAcceptance(id) {
    const row = await repo.get(id);
    if (!row || !['read', 'native'].includes(row.mode) || !nativeWork(row)) return null;
    await session(row.sessionId);
    const turn = await conversations.getTurn({ ...query(row.sessionId), traceId: row.turnId });
    if (!turn || hash(turn.inputText) !== row.requestSha256) throw notFound();
    return { authority: 'core.conversation-works', accepted: true, id: row._id,
      sessionId: row.sessionId, turnId: row.turnId, requestSha256: row.requestSha256,
      state: row.state, resultReady: Boolean(row.result), mode: row.mode,
      foreground: row.foreground || (row.mode === 'native' && !nativeForeground(turn.inputText) ? 'guardian' : 'acknowledge') };
  }
  async function guardianTool(context) {
    const row = await binding(context, 'guardian');
    if (row.mode !== 'native') throw notFound();
    return { authority: 'core.conversation-works', delegated: true, id: row._id, state: row.state,
      execution: row.result ? 'completed' : ['failed', 'cancelled'].includes(row.state) ? row.state : 'pending' };
  }
  async function automaticSpeech(row, evidence) {
    if (row.mode === 'native' && (row.guardian?.disposition === 'awaiting_main'
        || row.guardian?.state === 'failed')) return true;
    if (row.classification === 'native_review' || row.foreground === 'guardian') {
      // Older accepted turns have no semantic guardian disposition. Their
      // original verified tool work can still return without redispatching it.
      const turn = await conversations.getTurn({ ...query(row.sessionId), traceId: row.turnId });
      if (!turn || hash(turn.inputText) !== row.requestSha256 || simple(turn.inputText)) return false;
      if (row.mode === 'native' && guardianNeedsMain(turn.replyText)) return true;
      if (row.guardian?.disposition === 'answered') return false;
      if (!evidence) {
        const receipt = row.tools?.find(tool => tool.tool === 'native.consultation' && tool.runId === row.attempt?.runId);
        if (receipt) evidence = await repo.read(row, receipt.payloadRef);
      }
      return Boolean(evidence?.toolChecks?.runId === row.attempt?.runId
        && evidence.toolChecks.completedTools?.some(tool => !['tool_search', 'conversation_work', 'memory_search', 'memory_get'].includes(tool)));
    }
    if (row.delivery?.automaticSpeech !== undefined) return row.delivery.automaticSpeech;
    // Older native_work rows raced ordinary conversation before the guardian
    // finished. Keep their original result and owner, but require explicit
    // listening when this request had a conversational foreground response.
    if (row.mode === 'native' && row.classification === 'native_work' && !row.foreground) {
      const turn = await conversations.getTurn({ ...query(row.sessionId), traceId: row.turnId });
      return Boolean(turn && hash(turn.inputText) === row.requestSha256 && nativeForeground(turn.inputText));
    }
    return true;
  }
  let recoveryCursor;
  async function recover() {
    // Accepted input is recoverable, not permission to replay the guardian.
    const page = await exchangeStore.listRecoverable(EXCHANGE_SCOPE, { cursor: recoveryCursor });
    recoveryCursor = page.nextCursor || undefined;
    for (const item of page.items) {
      if (item.state !== 'accepted') continue;
      const receipt = await exchangeStore.read(EXCHANGE_SCOPE, item.id);
      const input = receipt?.request?.body;
      if (!input || !MODES.includes(input.mode)) continue;
      const current = await session(input.sessionId).catch(() => null);
      if (!current) continue;
      const id = hash(input.sessionId + '\n' + input.clientTurnId);
      let row = await repo.get(id);
      if (!row) {
        if ((await repo.find({ state: { $in: ACTIVE } }, LIMITS.open)).length >= LIMITS.open) continue;
        const taken = await conversations.acceptTurn({ ...query(input.sessionId), modeId: current.modeId,
          traceId: input.clientTurnId, clientTurnId: input.clientTurnId, channel: input.channel,
          inputText: input.text, attachments: input.attachments });
        const at = now();
        row = await repo.insert({ _id: id, owner: OWNER, surface: 'household', conversationId: current.conversationId,
          sessionId: input.sessionId, turnId: input.clientTurnId, exchangeId: item.id, requestSha256: hash(input.text),
          mode: input.mode, state: 'received', revision: 0,
          receivedAt: at, updatedAt: at, contextReady: false, tools: [], events: [], sequence: 0,
          guardian: { state: taken.turn.outcome === 'pending' ? 'uncertain' : taken.turn.outcome }, erased: false,
          classification: classification(input.text, input.mode) });
      }
      // A live intake can still be collecting context. Recovery never steals it.
      // After restart, stale pre-dispatch input is safe to dispatch only as a new
      // worker attempt, while the guardian's lost result remains explicitly unknown.
      if (row.state === 'received' && now().getTime() - new Date(row.receivedAt).getTime() > 60000) {
        if (row.classification === 'native_only') {
          await repo.mutate(id, saved => saved.state !== 'received' ? null : { fields: { state:
            ['completed', 'failed', 'cancelled'].includes(saved.guardian?.state) ? saved.guardian.state : 'uncertain',
            reason: 'native_guardian_receipt_required' }, event: 'native_intake_retained' });
          continue;
        }
        await repo.mutate(id, async (saved, fence) => saved.state !== 'received' ? null : {
          fields: { contextReady: true, contextRef: saved.contextRef || await repo.payload(saved, { selectedContext:
            'Recovered human intake. Selected personal context was not committed; use the complete canonical conversation and state what is missing.' }, fence),
            state: 'queued', guardian: { ...saved.guardian, state: ['pending', 'running'].includes(saved.guardian?.state) ? 'uncertain' : saved.guardian?.state } }, event: 'intake_recovered' });
      }
      if (['completed', 'failed', 'cancelled'].includes(row.state) && row.guardian?.state !== 'pending') await finalize(row);
    }
  }
  const handled = id => repo.mutate(id, current => current.attempt ? null : { fields: { state: 'completed', reason: 'deterministic_guardian_answer' }, event: 'guardian_handled' });
  async function finalize(row) {
    const receipt = await exchangeStore.read(EXCHANGE_SCOPE, row.exchangeId);
    if (receipt?.state === 'accepted') await exchangeStore.finish({ _id: row.exchangeId, scope: EXCHANGE_SCOPE,
      conversationId: row.conversationId }, 'completed', { packets: 0, statusCode: 200,
      conversationId: row.conversationId, workId: row._id });
  }
  return { repo, intake, retained, prepare, guardianStarted, guardianSettled, binding, request, contextForWorker, conversationContext, readTasks,
    contextForNative: context => contextForWorker(context, 'boss'), guardianTool,
    nativeOwner: async context => { const row = await binding(context, 'boss');
      return { authority: 'core.conversation-works', id: row._id, sessionId: row.sessionId }; },
    admitNativeTool: require('./native-budget').createNativeBudget({ repo, conversations, session, query, policy: nativeBudget, now }),
    publish, publishNative: require('./native-results').createNativeResultReceiver({ repo, session, now, automaticSpeech }), automaticSpeech, presentResult,
    recover, finalize, handled, guardianContext, guardianContextWithRefs, taskAcceptance, nativeAcceptance, wake: () => wake(), session, query, eligible: (current, channel) => eligible(current, channel, env), wakeWith: fn => { wake = fn; } };
}
module.exports = { createConversationWorks };
