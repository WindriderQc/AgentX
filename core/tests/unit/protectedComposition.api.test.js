'use strict';
const express = require('express');
const httpRequest = require('supertest');
const { randomUUID } = require('node:crypto');
jest.mock('../../models/ImageOperation', () => ({ findById: jest.fn() }));
const { createRouter } = require('../../routes/local-images');
const { createService } = require('../../src/services/images/protectedComposition');

function app(compositions, images = {}) {
  const value = express(); value.use(express.json()); value.use('/api/images', createRouter(images, {}, {}, compositions)); return value;
}
const body = () => ({ parentSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), regions: [{ x: 0, y: 0, width: 1, height: 1 }] });

test('the composition route returns a read-only downloadable result with private no-store headers', async () => {
  const id = randomUUID(), output = { receipt: { schema: 'agentx.protected-image-composition/v1' }, png: 'cG5n' };
  const compositions = { build: jest.fn(async () => output) }, images = { accept: jest.fn(), initialize: jest.fn(), recover: jest.fn() };
  const response = await httpRequest(app(compositions, images)).post(`/api/images/operations/${id}/protected-composition`).send(body()).expect(200);
  expect(response.body).toEqual({ ok: true, ...output });
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(compositions.build).toHaveBeenCalledWith(id, body());
  expect(images.accept).not.toHaveBeenCalled(); expect(images.initialize).not.toHaveBeenCalled(); expect(images.recover).not.toHaveBeenCalled();
});

test.each([400, 409, 503])('returns a bounded composition refusal with HTTP %i', async statusCode => {
  const error = Object.assign(new Error('Composition refused'), { statusCode });
  const response = await httpRequest(app({ build: async () => { throw error; } })).post(`/api/images/operations/${randomUUID()}/protected-composition`).send(body()).expect(statusCode);
  expect(response.body).toEqual({ ok: false, code: 'LOCAL_IMAGE_ERROR', message: 'Composition refused' });
  expect(response.headers['cache-control']).toBe('private, no-store');
});

test('refuses malformed IDs and unsupported inputs before any database or archive access', async () => {
  const operations = { findById: jest.fn() }, archive = jest.fn(), service = createService({ operations, archive });
  await httpRequest(app(service)).post('/api/images/operations/invalid-id/protected-composition').send(body()).expect(404);
  await httpRequest(app(service)).post(`/api/images/operations/${randomUUID()}/protected-composition`).send({ ...body(), url: 'https://example.test' }).expect(400);
  expect(operations.findById).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
});

test('GET never executes composition and internal errors do not expose details', async () => {
  const compositions = { build: jest.fn(async () => { throw new Error('Private filesystem error'); }) };
  await httpRequest(app(compositions)).get(`/api/images/operations/${randomUUID()}/protected-composition`).expect(404);
  expect(compositions.build).not.toHaveBeenCalled();
  const response = await httpRequest(app(compositions)).post(`/api/images/operations/${randomUUID()}/protected-composition`).send(body()).expect(503);
  expect(JSON.stringify(response.body)).not.toContain('Private filesystem');
});
