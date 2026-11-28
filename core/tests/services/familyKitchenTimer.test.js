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

test('a replacement timer is untouched by replayed Core mutations', async () => {
  let time = 3_000_000;
  const timer = createFamilyKitchenTimer({ mongoose, now: () => time });
  const run = (action, requestId, seconds) => timer.perform({ action, seconds }, { requestId });
  await run('cancel', 'cancel-while-empty');
  const a = await run('start', 'create-a', 60);
  await run('extend', 'extend-a', 30);
  await run('cancel', 'cancel-a');
  const b = await run('start', 'create-b', 120);
  for (const [action, id, seconds] of [['extend', 'extend-a', 30], ['cancel', 'cancel-a'], ['cancel', 'cancel-while-empty']]) {
    expect((await run(action, id, seconds)).outcome).toBe('unchanged');
    expect(await timer.read()).toEqual(b.timer);
  }
  time = b.timer.endsAt;
  expect((await run('start', 'create-a', 60)).outcome).toBe('unchanged');
  expect((await timer.read()).id).toBe(b.timer.id);
  expect((await timer.read()).state).toBe('finished');
  expect(a.timer.id === b.timer.id).toBe(false);
});


test('existing active timer rows without revision keep their deadline through the upgrade', async () => {
  const now = 4_000_000, id = '00000000-0000-4000-8000-000000000001';
  await mongoose.connection.collection('household_kitchen_timers').replaceOne({ _id: 'family' }, {
    _id: 'family', timerId: id, endsAt: now + 60_000, durationSeconds: 60, cancelledAt: null, alertClaimedAt: null
  }, { upsert: true });
  const timer = createFamilyKitchenTimer({ mongoose, now: () => now });
  expect(await timer.read()).toMatchObject({ id, endsAt: now + 60_000 });
  const extended = await timer.perform({ action: 'extend', seconds: 15 }, { requestId: 'first-on-upgrade' });
  expect(extended).toMatchObject({ outcome: 'extended', timer: { id, endsAt: now + 75_000 } });
});
