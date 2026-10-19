'use strict';

/**
 * Owner unlock of a family-pinned device (#826, part 2): "Nestor superDad"
 * followed by the secret phrase, heard in Core's own speech-recognition proxy,
 * opens full access on that device for a few minutes. No real STT: the
 * upstream speech service is a stub returning the transcript under test.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const request = require('supertest');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');
const familyDevice = require('../../surfaces/household/family-device');
const ownerUnlockModule = require('../../surfaces/household/owner-unlock');
const { registerTranscriptionProxy } = require('../../src/services/voice/voix-transcription');

const PHRASE = 'Le hibou chante à minuit';
const HASH = ownerUnlockModule.hashPhrase(PHRASE);

function harness({ env = { HOUSEHOLD_OWNER_UNLOCK_PHRASE_HASH: HASH }, unlock } = {}) {
  const clock = { now: new Date('2026-10-19T20:00:00Z') };
  const alerts = { create: jest.fn(async () => ({})) };
  const ownerUnlock = unlock || ownerUnlockModule.createOwnerUnlock({ mongoose, logger: null, env, now: () => new Date(clock.now), alerts });
  const heard = { text: '' };
  const instance = express();
  instance.use(cookieParser());
  const envelope = (res, data, status = 200) => res.status(status).json({ ok: true, status: 'success', data });
  const fail = (res, status, message, code) => res.status(status).json({ ok: false, status: 'error', message, code });
  familyDevice.register({ app: instance, mongoose, standardJsonParser: express.json(), envelope, fail, logger: null, ownerUnlock });
  const voix = express.Router();
  const upstream = {
    send: async () => ({
      upstream: 'stub',
      response: { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => Buffer.from(JSON.stringify({ text: heard.text, language: 'fr' })) }
    })
  };
  registerTranscriptionProxy(voix, {
    express, normalizeMultipart: (body) => body, upstream, fetchWithTimeout: null, timeoutMs: () => 1000, fail,
    interceptTranscript: (req, result) => ownerUnlock.intercept(req, result, { tokenHash: req.familyDevice?.tokenHash })
  });
  instance.use('/api/voix', voix);
  for (const path of ['/panel', '/dad']) instance.get(path, (_req, res) => res.send(path));
  instance.post('/api/voice-personas/private/sessions', (_req, res) => res.json({ ok: true }));
  instance.get('/api/memory/notes', (_req, res) => res.json({ ok: true }));
  const say = (agent, text) => { heard.text = text; return agent.post('/api/voix/transcribe').set('Content-Type', 'application/octet-stream').send(Buffer.from('synthetic-audio')); };
  return { instance, clock, alerts, say };
}

async function pinnedTablet(instance) {
  const tablet = request.agent(instance);
  expect((await tablet.post('/api/household/family-device/pin').send({ label: 'Tablet' })).status).toBe(201);
  return tablet;
}
const audit = () => mongoose.models.AgentXHouseholdOwnerUnlockAudit.find({}).sort({ at: 1 }).lean();

describe('spoken trigger and phrase', () => {
  test('finds the phrase after the trigger however recognition spelled it', () => {
    expect(ownerUnlockModule.splitTrigger('Nestor superDad, le hibou chante à minuit.')).toEqual({ phrase: 'le hibou chante a minuit' });
    expect(ownerUnlockModule.splitTrigger('Hey Nestor super dad le hibou')).toEqual({ phrase: 'le hibou' });
    expect(ownerUnlockModule.splitTrigger('nestor super-dad')).toEqual({ phrase: '' });
    expect(ownerUnlockModule.splitTrigger('Nestor, what is super dad?')).toBeNull();
    expect(ownerUnlockModule.splitTrigger('')).toBeNull();
  });

  test('the hash matches the phrase with other punctuation, case and accents, and nothing else', () => {
    expect(HASH).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(HASH).not.toContain('hibou');
    expect(ownerUnlockModule.verifyPhrase('le hibou chante a minuit', HASH)).toBe(true);
    expect(ownerUnlockModule.verifyPhrase('LE HIBOU, chante à... minuit', HASH)).toBe(true);
    expect(ownerUnlockModule.verifyPhrase('le hibou chante a midi', HASH)).toBe(false);
    expect(ownerUnlockModule.verifyPhrase('', HASH)).toBe(false);
    expect(ownerUnlockModule.verifyPhrase('le hibou chante a minuit', 'not-a-hash')).toBe(false);
  });
});

describe('owner unlock of a pinned device', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectTestDb();
  });
  beforeEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  test('the phrase opens full access, the page never receives it, and the unlock ends at its time', async () => {
    const { instance, clock, alerts, say } = harness();
    const tablet = await pinnedTablet(instance);
    expect((await tablet.get('/dad')).status).toBe(302);

    const answer = await say(tablet, 'Nestor superDad, le hibou chante à minuit.');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ text: '', control: 'owner_unlock', unlocked: true, until: '2026-10-19T20:10:00.000Z' });
    expect(JSON.stringify(answer.body)).not.toMatch(/hibou/i);

    expect((await tablet.get('/dad')).status).toBe(200);
    expect((await tablet.post('/api/voice-personas/private/sessions')).status).toBe(200);
    expect((await tablet.get('/api/memory/notes')).status).toBe(200);
    expect((await tablet.get('/api/household/family-device')).body.data).toMatchObject({ pinned: true, unlockedUntil: '2026-10-19T20:10:00.000Z' });
    expect(alerts.create).toHaveBeenCalledWith(expect.objectContaining({ ruleId: 'household_owner_unlock', severity: 'info' }));
    expect(JSON.stringify(alerts.create.mock.calls)).not.toMatch(/hibou/i);

    clock.now = new Date('2026-10-19T20:10:01Z');
    expect((await tablet.get('/dad')).status).toBe(302);
    expect((await tablet.get('/api/memory/notes')).status).toBe(403);
    expect((await audit()).map((row) => row.outcome)).toEqual(['unlocked']);
  });

  test('a wrong phrase opens nothing, is swallowed and audited once a minute', async () => {
    const { instance, clock, say } = harness();
    const tablet = await pinnedTablet(instance);
    const answer = await say(tablet, 'Nestor superDad le hibou chante à midi');
    expect(answer.body).toEqual({ text: '', control: 'owner_unlock' });
    await say(tablet, 'Nestor superDad le hibou');
    expect((await tablet.get('/dad')).status).toBe(302);
    clock.now = new Date('2026-10-19T20:01:30Z');
    await say(tablet, 'Nestor superDad encore');
    const rows = await audit();
    expect(rows.map((row) => row.outcome)).toEqual(['refused', 'refused']);
    expect(JSON.stringify(rows)).not.toMatch(/hibou|midi|encore/);
  });

  test('Relock ends full access at once', async () => {
    const { instance, say } = harness();
    const tablet = await pinnedTablet(instance);
    await say(tablet, 'Nestor superDad le hibou chante à minuit');
    expect((await tablet.get('/dad')).status).toBe(200);
    expect((await tablet.post('/api/household/family-device/relock')).body.data).toEqual({ pinned: true, relocked: true });
    expect((await tablet.get('/dad')).status).toBe(302);
    expect((await audit()).map((row) => row.outcome)).toEqual(['unlocked', 'relocked']);
  });

  test('ordinary speech passes through, and the trigger alone unlocks nothing on an unpinned device', async () => {
    const { instance, say } = harness();
    const tablet = await pinnedTablet(instance);
    expect((await say(tablet, 'Raconte-moi une histoire')).body).toEqual({ text: 'Raconte-moi une histoire', language: 'fr' });
    const laptop = request.agent(instance);
    expect((await say(laptop, 'Nestor superDad le hibou chante à minuit')).body).toEqual({ text: '', control: 'owner_unlock' });
    expect(await mongoose.models.AgentXHouseholdOwnerUnlock.countDocuments()).toBe(0);
  });

  test('without a configured hash nothing unlocks', async () => {
    const { instance, say } = harness({ env: {} });
    const tablet = await pinnedTablet(instance);
    expect((await say(tablet, 'Nestor superDad le hibou chante à minuit')).body).toEqual({ text: '', control: 'owner_unlock' });
    expect((await tablet.get('/dad')).status).toBe(302);
    expect((await audit()).map((row) => row.outcome)).toEqual(['not-configured']);
  });

  test('an unlock store Core cannot read keeps the device locked', async () => {
    const unlock = { activeUntil: async () => { throw new Error('store down'); }, intercept: async () => null, relock: async () => false, forget: async () => {} };
    const { instance } = harness({ unlock });
    const tablet = await pinnedTablet(instance);
    expect((await tablet.get('/dad')).status).toBe(302);
    expect((await tablet.get('/panel')).status).toBe(200);
  });

  test('unpinning the device removes its unlock', async () => {
    const { instance, say } = harness();
    const tablet = await pinnedTablet(instance);
    await say(tablet, 'Nestor superDad le hibou chante à minuit');
    const owner = request.agent(instance);
    const { body } = await owner.get('/api/household/family-devices');
    await owner.delete(`/api/household/family-devices/${body.data.devices[0].id}`);
    expect(await mongoose.models.AgentXHouseholdOwnerUnlock.countDocuments()).toBe(0);
  });
});
