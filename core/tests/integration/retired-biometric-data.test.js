'use strict';
const mongoose = require('mongoose');
const request = require('supertest');
const { app } = require('../../src/app');

test('human journeys leave existing face descriptors and code hashes untouched', async () => {
  const faces = mongoose.connection.collection('access_face_enrollments');
  const codes = mongoose.connection.collection('access_parental_code');
  const descriptors = [Array.from({ length: 128 }, (_, index) => index / 128)];
  const face = { subject: 'default', descriptors };
  const code = { subject: 'default', salt: 'synthetic-salt', hash: 'synthetic-hash' };
  await faces.insertOne(face); await codes.insertOne(code);
  for (const path of ['/dad', '/panel', '/psyx']) await request(app).get(path).expect(200);
  await request(app).get('/unlock').expect(302);
  await request(app).delete('/api/access/face/enrollment').expect(404);
  expect(await faces.findOne({ subject: 'default' })).toEqual(face);
  expect(await codes.findOne({ subject: 'default' })).toEqual(code);
});
