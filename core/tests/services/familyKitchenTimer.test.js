'use strict';

const mongoose = require('mongoose');
const { createFamilyKitchenTimer } = require('../../src/services/familyKitchenTimer');

test('a real Core Mongo store has one winner across concurrent starts and across expiry claims', async () => {
  let time = 1_000_000;
  const now = () => time;
  const a = createFamilyKitchenTimer({ mongoose, now });
  const b = createFamilyKitchenTimer({ mongoose, now });
  const starts = await Promise.all([
    a.perform({ action: 'start', seconds: 120 }, { requestId: 'start-a' }),
    b.perform({ action: 'start', seconds: 180 }, { requestId: 'start-b' })
  ]);
  expect(starts.filter(result => result.outcome === 'started')).toHaveLength(1);
  expect(starts[0].timer.id).toEqual(starts[1].timer.id);
  const id = starts[0].timer.id;
  const saved = await b.read();
  expect(saved.endsAt).toBe(starts[0].timer.endsAt);
  expect(await b.claimAlert(id)).toEqual({ claimed: false });
  time = saved.endsAt;
  const claims = await Promise.all([a.claimAlert(id), b.claimAlert(id), a.claimAlert(id)]);
  expect(claims.filter(claim => claim.claimed)).toHaveLength(1);
  expect(await b.read()).toMatchObject({ id, state: 'finished', alertClaimed: true });
  const next = await a.perform({ action: 'start', seconds: 10 }, { requestId: 'new-start' });
  expect(next.timer.id).not.toEqual(id);
  await b.perform({ action: 'cancel' }, { requestId: 'cancel' });
  expect(await a.read()).toMatchObject({ state: 'idle' });
  time += 10_000;
  expect(await a.claimAlert(next.timer.id)).toEqual({ claimed: false });
});

test('Core adds time once across concurrent retries and keeps the same timer and alert', async () => {
  let time = 2_000_000;
  const timer = createFamilyKitchenTimer({ mongoose, now: () => time });
  const started = await timer.perform({ action: 'start', seconds: 60 }, { requestId: 'start' });
  const extend = () => timer.perform({ action: 'extend', seconds: 30 }, { requestId: 'one-extension' });
  const results = await Promise.all([extend(), extend()]);
  expect(results.filter(result => result.outcome === 'extended')).toHaveLength(1);
  expect((await extend()).outcome).toBe('unchanged');
  const active = await timer.read();
  expect(active).toMatchObject({ id: started.timer.id, endsAt: time + 90_000 });
  time = started.timer.endsAt;
  expect(await timer.claimAlert(active.id)).toEqual({ claimed: false });
  time = active.endsAt;
  expect(await timer.claimAlert(active.id)).toEqual({ claimed: true });
  expect(await timer.claimAlert(active.id)).toEqual({ claimed: false });
});
