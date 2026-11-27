'use strict';

const mongoose = require('mongoose');
const { createFamilyKitchenTimer } = require('../../src/services/familyKitchenTimer');

test('a real Core Mongo store has one winner across concurrent starts and across expiry claims', async () => {
  let time = 1_000_000;
  const now = () => time;
  const a = createFamilyKitchenTimer({ mongoose, now });
  const b = createFamilyKitchenTimer({ mongoose, now });
  const starts = await Promise.all([
    a.command('Mets une minuterie de 2 minutes'),
    b.command('Lance une minuterie de 3 minutes')
  ]);
  expect(starts.filter(result => result.reply.text.startsWith('C’est parti.'))).toHaveLength(1);
  expect(starts[0].timer.id).toEqual(starts[1].timer.id);
  const id = starts[0].timer.id;
  const saved = await b.read();
  expect(saved.endsAt).toBe(starts[0].timer.endsAt);
  expect(await b.claimAlert(id)).toEqual({ claimed: false });
  time = saved.endsAt;
  const claims = await Promise.all([a.claimAlert(id), b.claimAlert(id), a.claimAlert(id)]);
  expect(claims.filter(claim => claim.claimed)).toHaveLength(1);
  expect(await b.read()).toMatchObject({ id, state: 'finished', alertClaimed: true });
  const next = await a.command('Mets une minuterie de 10 secondes');
  expect(next.timer.id).not.toEqual(id);
  await b.command('Annule la minuterie');
  expect(await a.read()).toMatchObject({ state: 'idle' });
  time += 10_000;
  expect(await a.claimAlert(next.timer.id)).toEqual({ claimed: false });
});
