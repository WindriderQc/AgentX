'use strict';

const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const queue = require('../../src/services/heavyWorkQueueService');
const placement = require('../../../shared/heavyWorkPlacement');
const GPU = 'http://10.0.0.5:11434';
const CPU = 'http://10.0.0.5:11435';
const OTHER = 'http://10.0.0.6:11434';
const profile = (key, host = GPU, minutes = 60, extra = {}) => ({ key, title: `Synthetic ${key}`, kind: 'profiler', hosts: [host], estimatedMinutes: minutes,
  executor: { hostId: 'fixture', depth: 'full', skipRecentDays: 0, modelNames: ['synthetic:model'] }, ...extra });
const minutesFromNow = iso => Math.round((Date.parse(iso) - Date.now()) / 60000);

beforeEach(async () => {
  await Queue.deleteMany({}); await Archive.deleteMany({});
  delete process.env.HEAVY_WORK_NIGHT_WINDOW;
  process.env.PLANNING_TIME_ZONE = 'America/Toronto';
});

describe('night window', () => {
  const tz = { timeZone: 'America/Toronto' };
  it('gives tonight 23:00 to 06:00 in the owner zone, from now when already inside it', () => {
    const afternoon = Date.parse('2026-10-19T18:00:00Z');
    expect(placement.nightWindow(afternoon, tz)).toEqual({ start: Date.parse('2026-10-20T03:00:00Z'), end: Date.parse('2026-10-20T10:00:00Z') });
    const lateNight = Date.parse('2026-10-20T05:30:00Z');
    expect(placement.nightWindow(lateNight, tz)).toEqual({ start: lateNight, end: Date.parse('2026-10-20T10:00:00Z') });
    const morning = Date.parse('2026-10-20T11:00:00Z');
    expect(placement.nightWindow(morning, tz).start).toBe(Date.parse('2026-10-21T03:00:00Z'));
  });
  it('follows the daylight-saving change and a configured window', () => {
    // 2026-11-01: Toronto leaves daylight time; 23:00 on Nov 1 is 04:00 UTC.
    expect(placement.nightWindow(Date.parse('2026-11-01T18:00:00Z'), tz))
      .toEqual({ start: Date.parse('2026-11-02T04:00:00Z'), end: Date.parse('2026-11-02T11:00:00Z') });
    expect(placement.nightWindow(Date.parse('2026-10-19T18:00:00Z'), { ...tz, spec: '01:00-05:00' }))
      .toEqual({ start: Date.parse('2026-10-20T05:00:00Z'), end: Date.parse('2026-10-20T09:00:00Z') });
    expect(placement.parseWindow('nonsense')).toEqual(placement.parseWindow(placement.DEFAULT_NIGHT));
  });
});

describe('Core places a request from a When choice', () => {
  it('as soon as possible: the first free minute, after work already on the same machine', async () => {
    const first = await queue.submit(profile('first'), 'test');
    const booked = await queue.place(first.id, { expectedRevision: first.revision, when: 'asap', autoStart: true }, 'owner');
    expect(booked.reservation).toMatchObject({ when: 'asap', autoStart: true });
    expect(minutesFromNow(booked.reservation.start)).toBeLessThanOrEqual(2);
    // Another endpoint of the same machine waits; another machine does not.
    const cpu = await queue.submit(profile('cpu', CPU), 'test');
    const cpuSlot = await queue.place(cpu.id, { expectedRevision: cpu.revision, when: 'asap' }, 'owner');
    expect(cpuSlot.reservation.start).toBe(booked.reservation.end);
    const other = await queue.submit(profile('other', OTHER), 'test');
    const otherSlot = await queue.place(other.id, { expectedRevision: other.revision, when: 'asap' }, 'owner');
    expect(minutesFromNow(otherSlot.reservation.start)).toBeLessThanOrEqual(2);
  });

  it('tonight: inside the night window and refused when it cannot end there', async () => {
    process.env.HEAVY_WORK_NIGHT_WINDOW = '23:00-06:00';
    const job = await queue.submit(profile('night', GPU, 180), 'test');
    const night = placement.nightWindow(Date.now(), { timeZone: 'America/Toronto' });
    const slot = await queue.preview(job.id, { when: 'tonight' });
    expect(Date.parse(slot.start)).toBeGreaterThanOrEqual(Math.floor(night.start / 60000) * 60000);
    expect(slot.fits).toBe(Date.parse(slot.end) <= night.end);
    const long = await queue.submit(profile('too-long', OTHER, 9 * 60), 'test');
    await expect(queue.place(long.id, { expectedRevision: long.revision, when: 'tonight' }, 'owner'))
      .rejects.toMatchObject({ code: 'HEAVY_QUEUE_NO_SLOT', details: { earliest: expect.any(String) } });
    expect((await queue.get(long.id)).state).toBe('requested');
  });

  it('respects the request start limits and an exact time', async () => {
    const later = new Date(Math.ceil((Date.now() + 5 * 3600000) / 60000) * 60000).toISOString();
    const bounded = await queue.submit(profile('bounded', GPU, 30, { notBefore: later }), 'test');
    const slot = await queue.place(bounded.id, { expectedRevision: bounded.revision, when: 'asap' }, 'owner');
    expect(slot.reservation.start).toBe(later);
    const closed = await queue.submit(profile('closed', OTHER, 30, { startBefore: new Date(Date.now() + 30000).toISOString() }), 'test');
    await expect(queue.place(closed.id, { expectedRevision: closed.revision, when: 'asap' }, 'owner')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_NO_SLOT' });
    const exact = await queue.submit(profile('exact', CPU, 30), 'test');
    const at = new Date(Date.now() + 26 * 3600000).toISOString();
    expect((await queue.place(exact.id, { expectedRevision: exact.revision, when: 'at', at }, 'owner')).reservation).toMatchObject({ start: at, when: 'at' });
  });

  it('needs the current revision and a known choice', async () => {
    const job = await queue.submit(profile('guarded'), 'test');
    await expect(queue.place(job.id, { when: 'asap' }, 'owner')).rejects.toMatchObject({ statusCode: 400 });
    await expect(queue.place(job.id, { expectedRevision: job.revision + 1, when: 'asap' }, 'owner')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_STALE' });
    await expect(queue.place(job.id, { expectedRevision: job.revision, when: 'someday' }, 'owner')).rejects.toMatchObject({ statusCode: 400 });
    await expect(queue.place(job.id, { expectedRevision: job.revision, when: 'at', at: 'tomorrow' }, 'owner')).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each(['dispatching', 'running', 'uncertain'])('%s cannot promise a slot before its native release, even past its estimate', async state => {
    const holder = await queue.submit(profile('active-holder'), 'test');
    const reservation = {
      start: new Date(Date.now() - 20 * 60000).toISOString(),
      end: new Date(Date.now() - 5 * 60000).toISOString()
    };
    await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': holder.id }, {
      $set: { 'jobs.$.state': state, 'jobs.$.reservation': reservation }
    });
    const target = await queue.submit(profile('waiting'), 'test');
    const conflict = { statusCode: 409, code: 'HEAVY_QUEUE_CONFLICT',
      details: { conflicts: [{ id: holder.id, title: holder.title, state, reservation }] } };
    for (const when of ['asap', 'tonight', 'at']) {
      const choice = { when, at: new Date(Date.now() + 24 * 3600000).toISOString() };
      await expect(queue.preview(target.id, choice)).rejects.toMatchObject(conflict);
      await expect(queue.place(target.id, { ...choice, expectedRevision: target.revision }, 'owner')).rejects.toMatchObject(conflict);
    }
    expect(await queue.get(target.id)).toMatchObject({ state: 'requested', revision: target.revision, reservation: null });
    expect(await queue.get(holder.id)).toMatchObject({ state, reservation });

    // A terminal receipt removes this fence; the original request can then be placed.
    await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': holder.id }, { $set: { 'jobs.$.state': 'completed' } });
    expect((await queue.preview(target.id, { when: 'asap' })).fits).toBe(true);
    expect((await queue.place(target.id, { expectedRevision: target.revision, when: 'asap' }, 'owner')).state).toBe('reserved');
  });

  it('blocks another endpoint on the active machine while leaving independent machines available', async () => {
    const holder = await queue.submit(profile('gpu-holder'), 'test');
    await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': holder.id }, {
      $set: { 'jobs.$.state': 'running', 'jobs.$.reservation': {
        start: new Date().toISOString(), end: new Date(Date.now() + 5 * 60000).toISOString()
      } }
    });
    const cpu = await queue.submit(profile('same-machine', CPU), 'test');
    await expect(queue.preview(cpu.id, { when: 'asap' })).rejects.toMatchObject({
      code: 'HEAVY_QUEUE_CONFLICT', details: { conflicts: [expect.objectContaining({ id: holder.id })] }
    });
    const other = await queue.submit(profile('independent', OTHER), 'test');
    expect((await queue.preview(other.id, { when: 'asap' })).fits).toBe(true);
    expect((await queue.place(other.id, { expectedRevision: other.revision, when: 'asap' }, 'owner')).state).toBe('reserved');
  });

  it('also fences physical-resource aliases with different hostnames', () => {
    const target = { id: 'waiting', hosts: [OTHER], resourceIds: ['synthetic-shared-device'], estimatedMinutes: 30 };
    const holder = { id: 'holder', title: 'Synthetic active alias', state: 'uncertain',
      hosts: [GPU], resourceIds: ['synthetic-shared-device'], reservation: null };
    expect(() => queue.slotFor({ jobs: [holder, target] }, target, 'asap')).toThrow(
      expect.objectContaining({ code: 'HEAVY_QUEUE_CONFLICT',
        details: { conflicts: [{ id: holder.id, title: holder.title, state: holder.state, reservation: null }] } })
    );
  });
});
