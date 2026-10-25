'use strict';

const Task = require('../../models/PipelineTask');
const Dossier = require('../../models/PersonalTaskDossier');
const Signal = require('../../models/PersonalTaskEvidenceSignal');
const signals = require('../../src/services/personalTaskEvidenceSignalService');
const personal = require('../../src/services/personalTaskService');
const dossiers = require('../../src/services/personalTaskDossierService');

const threadId = 'aaaaaaaaaaaaaaa1';
const messageId = 'aaaaaaaaaaaaaaa2';
const source = () => ({ id: `gmail:${messageId}:0`, kind: 'mail', direction: 'received', relation: 'authored',
  messageId, threadId, date: '2030-02-19T15:00:00Z', text: 'La rencontre est confirmée le 28 février à 13 h 30. Merci de préparer vos pièces.',
  sourceHash: 'a'.repeat(64), url: `https://mail.google.com/mail/#all/${messageId}` });
const update = () => ({ state: 'superseded', action: 'update', summary: 'La date est confirmée; la préparation reste ouverte.',
  actor: 'Personne Exemple', title: 'Préparer la rencontre du 28 février', dueAt: '2030-02-26',
  schedulingDecision: 'Choix de date réglé.', appointment: '28 février à 13 h 30, selon le message daté du 19.',
  remainingWork: ['Préparer les pièces.'], uncertainties: [],
  citations: [{ sourceId: source().id, quote: 'La rencontre est confirmée le 28 février à 13 h 30.' }] });

describe('personal dossier evidence and human decisions in Core', () => {
  let task, deps, native;
  beforeEach(async () => {
    await Promise.all([Task.deleteMany({}), Dossier.deleteMany({}), Signal.deleteMany({})]);
    task = await personal.createPersonalTask({ title: 'Choisir une date de rencontre', note: 'Original context retained.' });
    native = { threadId, sourceHash: 'a'.repeat(64), complete: true, documentsComplete: true, sources: [source()] };
    deps = { now: new Date('2030-02-20T15:00:00Z'), mail: { dossier: jest.fn(async () => native) },
      calendar: { operate: jest.fn(async () => ({ events: [] })) } };
  });
  const read = () => dossiers.read({ ref: task.id, threadIds: [threadId] }, deps);
  const propose = (review, proposal = update()) => dossiers.propose({ id: review.id, ...proposal });
  const decide = (review, decision = 'apply') => dossiers.decide({ id: review.id, proposalHash: review.proposalHash,
    revision: review.task.revision, decision }, deps);

  test('owner tool defaults to bounded metadata and pages the same saved evidence without rereading providers or changing a task', async () => {
    native.sources[0].text += ' Exact retained source. '.repeat(3000);
    const summary = await dossiers.operate({ action: 'read', ref: task.id, threadIds: [threadId] }, deps);
    expect(summary).toMatchObject({ view: 'summary', sourceCount: 1, task: { id: task.id, revision: 0 } });
    expect(summary.sources).toBeUndefined();
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(6000);
    const before = await Task.findOne({ pipelineId: task.id }).lean();
    const original = await dossiers.get(summary.id);
    let offset = 0, expectedHash, serialized = '';
    do {
      const page = await dossiers.operate({ action: 'get', id: summary.id, view: 'source', sourceId: source().id,
        offset, ...(expectedHash && { expectedHash }) });
      serialized += page.content;
      if (page.complete) break;
      offset = page.nextOffset; expectedHash = page.contentHash;
    } while (offset < 100000);
    expect(JSON.parse(serialized)).toEqual(original.sources[0]);
    expect(await dossiers.operate({ action: 'get', id: summary.id, view: 'full' })).toEqual(original);
    expect(deps.mail.dossier).toHaveBeenCalledTimes(1);
    expect(await Dossier.countDocuments()).toBe(1);
    expect(await Task.findOne({ pipelineId: task.id }).lean()).toEqual(before);
    await expect(dossiers.operate({ action: 'read', ref: task.id, view: 'source', sourceId: source().id }, deps)).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_VIEW_INVALID' });
    expect(await Dossier.countDocuments()).toBe(1);
  });

  test('reconciles first, proposes without mutation, then updates the same action with its original context and replay receipt', async () => {
    const review = await read();
    expect(deps.mail.dossier).toHaveBeenCalledWith({ threadId });
    expect(deps.calendar.operate).toHaveBeenCalledWith(expect.objectContaining({ action: 'list', calendarId: 'primary' }));
    expect(review).toMatchObject({ coverage: { tasks: 'read', mail: 'read', calendar: 'read', documents: 'read' },
      task: { title: task.title }, scope: expect.stringContaining('absence does not prove') });
    const proposed = await propose(review);
    expect((await Task.findOne({ pipelineId: task.id })).title).toBe(task.title);
    expect(await personal.listPersonalTasks()).toMatchObject({ tasks: [{ id: task.id, dossierReview: { action: 'update' } }] });
    expect((await personal.personalBriefing()).counts.dossierReview).toBe(1);
    const result = await decide(proposed);
    expect(result).toMatchObject({ replayed: false, task: { id: task.id, title: update().title, status: 'queued', revision: 1 } });
    const saved = await Task.findOne({ pipelineId: task.id }).lean();
    expect(saved.spec).toBe('Original context retained.');
    expect(saved.feedback[0].text).toContain(task.title);
    expect(saved.personalDossierDecisions).toHaveLength(1);
    expect((await personal.listPersonalTasks()).tasks[0].dossierHistory).toMatchObject({ id: proposed.id,
      citations: [{ url: source().url }], decision: { decision: 'apply' } });
    expect(await Task.countDocuments({ service: 'personal' })).toBe(1);
    expect(await decide(proposed)).toMatchObject({ replayed: true, receipt: { dossierId: proposed.id } });
    expect((await Task.findOne({ pipelineId: task.id })).feedback).toHaveLength(1);
    await expect(decide(proposed, 'dismiss')).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_CONFLICT' });
  });

  test('a newer reply or calendar edit invalidates the exact proposal before a decision', async () => {
    const proposed = await propose(await read());
    native.sourceHash = 'b'.repeat(64);
    await expect(decide(proposed)).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_SOURCES_CHANGED' });
    expect((await Task.findOne({ pipelineId: task.id })).title).toBe(task.title);
    native.sourceHash = 'a'.repeat(64);
    deps.calendar.operate.mockResolvedValue({ events: [{ id: 'new-event', status: 'cancelled', updated: '2030-02-20T16:00:00Z' }] });
    await expect(decide(proposed)).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_SOURCES_CHANGED' });
  });

  test('a competing task edit rejects both stale proposals and stale decisions', async () => {
    const review = await read();
    const proposed = await propose(review);
    await personal.updatePersonalTask({ ref: task.id, priority: 1 });
    await expect(propose(review)).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_CONFLICT' });
    await expect(decide(proposed)).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_CONFLICT' });
  });

  test.each(['draft', 'quoted', 'missing_date', 'truncated'])('%s cannot establish a confirmed state or close a task', async kind => {
    if (kind === 'draft') native.sources[0].direction = 'draft';
    if (kind === 'quoted') native.sources[0].relation = 'quoted';
    if (kind === 'missing_date') native.sources[0].date = null;
    if (kind === 'truncated') native.sources[0].truncated = true;
    const review = await read();
    await expect(propose(review)).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_EVIDENCE_REQUIRED' });
    const uncertain = { state: 'uncertain', action: 'keep', summary: 'Preuve actuelle insuffisante.', actor: '', citations: [], uncertainties: ['Retrouver une confirmation datée.'] };
    expect(await propose(review, uncertain)).toMatchObject({ proposal: { state: 'uncertain', action: 'keep' } });
  });

  test('refuses invented quotes, guessed actors, and closure with remaining work', async () => {
    const review = await read();
    await expect(propose(review, { ...update(), citations: [{ sourceId: source().id, quote: 'Invented completion' }] }))
      .rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_EVIDENCE_REQUIRED' });
    await expect(propose(review, { ...update(), actor: 'owner' })).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_INVALID' });
    await expect(propose(review, { ...update(), action: 'complete', state: 'resolved' })).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_INCOMPLETE' });
  });

  test.each(['calendar', 'documents', 'mail'])('incomplete %s coverage never produces a closure recommendation', async scope => {
    if (scope === 'calendar') deps.calendar.operate.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'AUTH_REQUIRED' }));
    if (scope === 'documents') native.documentsComplete = false;
    if (scope === 'mail') native.complete = false;
    const review = await read();
    await expect(propose(review, { ...update(), state: 'resolved', action: 'complete', remainingWork: [] }))
      .rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_INCOMPLETE' });
    expect((await Task.findOne({ pipelineId: task.id })).status).toBe('queued');
  });

  test('a dated resolution closes exactly one task only after the explicit decision, with its status event', async () => {
    native.sources[0].text = 'Les pièces ont été reçues; ce dossier est terminé.';
    const review = await read();
    const proposed = await propose(review, { ...update(), action: 'complete', state: 'resolved', remainingWork: [],
      citations: [{ sourceId: source().id, quote: native.sources[0].text }] });
    expect((await Task.findOne({ pipelineId: task.id })).status).toBe('queued');
    await decide(proposed);
    const saved = await Task.findOne({ pipelineId: task.id }).lean();
    expect(saved.status).toBe('done');
    expect(saved.transitions.at(-1)).toMatchObject({ from: 'queued', to: 'done', kind: 'personal_dossier_decision' });
    expect((await dossiers.get(proposed.id)).proposal.citations[0]).toMatchObject({ date: source().date, url: source().url });
  });

  test('competing apply and dismiss decisions commit one atomic task receipt', async () => {
    const proposed = await propose(await read());
    const outcomes = await Promise.allSettled([decide(proposed), decide(proposed, 'dismiss')]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const saved = await Task.findOne({ pipelineId: task.id }).lean();
    expect(saved.personalDossierDecisions).toHaveLength(1);
    expect(saved.feedback).toHaveLength(1);
  });

  test('proposal replay is stable, changed intent refuses and the model cannot apply', async () => {
    const review = await read();
    const first = await propose(review);
    expect((await propose(review)).proposalHash).toBe(first.proposalHash);
    await expect(propose(review, { ...update(), title: 'Different proposal' })).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_CONFLICT' });
    await expect(dossiers.operate({ action: 'apply', id: review.id })).rejects.toMatchObject({ code: 'PERSONAL_DOSSIER_INVALID' });
  });

  test('a resolved extraction links the existing task by its source without creating a duplicate or closing it', async () => {
    await Task.updateOne({ pipelineId: task.id }, { $set: { spec: `Original context https://mail.google.com/mail/#all/${threadId}`,
      personalReview: { state: 'accepted', reason: 'email' } } });
    const finding = { kind: 'action', key: 'd'.repeat(32), findingKey: 'f'.repeat(32), threadId, messageId, sourceDate: source().date,
      text: 'Une réponse plus récente rapporte une résolution.', owner: 'Personne Exemple', sourceStatus: 'resolved' };
    const receipt = await signals.route(finding);
    expect(receipt).toMatchObject({ signal: { effect: 'review_required_no_task_change', taskIds: [task.id] }, duplicate: false });
    expect(await signals.route({ ...finding, key: '1'.repeat(32) })).toMatchObject({ duplicate: true, signal: { id: receipt.signal.id } });
    expect(await Task.countDocuments()).toBe(1);
    expect((await Task.findOne({ pipelineId: task.id })).status).toBe('queued');
    expect((await personal.listPersonalTasks()).tasks[0].evidenceSignals.count).toBe(1);
    const review = await read();
    expect(review.evidenceSignals).toHaveLength(1);
    await expect(signals.route({ ...finding, text: 'A changed finding under an existing key' })).rejects.toMatchObject({ status: 409 });
  });

  test('an unlinked historical signal preserves uncertainty without manufacturing a personal task', async () => {
    const result = await signals.route({ kind: 'recheck', key: 'e'.repeat(32), threadId, messageId,
      sourceDate: '2020-01-01T10:00:00Z', text: 'Ancienne demande, sans état actuel établi.', owner: '', sourceStatus: 'historical' });
    expect(result.signal.taskIds).toEqual([]);
    expect(await Task.countDocuments()).toBe(1);
  });

  test('a pending extraction can read its sources before the owner accepts any commitment', async () => {
    await Task.updateOne({ pipelineId: task.id }, { $set: { personalReview: { state: 'pending', reason: 'email' } } });
    const review = await read();
    expect(review.task.personalReview.state).toBe('pending');
    expect(review.sources[0].text).toBe(source().text);
    await expect(propose(review)).rejects.toMatchObject({ code: 'SECRETARY_REVIEW_REQUIRED' });
    expect((await Task.findOne({ pipelineId: task.id })).personalReview.state).toBe('pending');
  });

  test('a task captured years ago can review the current calendar without an unbounded historical window', async () => {
    await Task.updateOne({ pipelineId: task.id }, { $set: { dueAt: new Date('2020-01-01') } });
    const review = await read();
    expect(review.selection.timeMin).toBe('2030-02-13T15:00:00.000Z');
    expect(Date.parse(review.selection.timeMax) - Date.parse(review.selection.timeMin)).toBeLessThan(366 * 86400000);
  });

  test('unanswered draft details remain open questions, distinct from accepted work', async () => {
    const proposed = await propose(await read(), { ...update(), openQuestions: ['Salle et durée non établies; le brouillon est non envoyé.'] });
    expect(proposed.proposal.remainingWork).toEqual(['Préparer les pièces.']);
    expect(proposed.proposal.openQuestions).toEqual(['Salle et durée non établies; le brouillon est non envoyé.']);
  });
});
