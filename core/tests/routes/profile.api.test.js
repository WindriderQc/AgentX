'use strict';

const request = require('supertest');
const { app } = require('../../src/app');
const UserProfile = require('../../models/UserProfile');

beforeAll(async () => {
  await UserProfile.syncIndexes();
});

afterEach(async () => {
  await UserProfile.deleteMany({});
});

const fullProfile = {
  about: 'Engineer who maintains the home cluster.',
  preferences: {
    customInstructions: 'Be brief.',
    language: 'Français',
    role: 'Home lab operator',
    style: 'Concise, with next steps.'
  }
};

describe('/api/profile', () => {
  test('returns an empty default profile without writing one', async () => {
    const res = await request(app).get('/api/profile');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      userId: 'default',
      about: '',
      preferences: { customInstructions: '', language: '', role: '', style: '' }
    });
    expect(await UserProfile.countDocuments()).toBe(0);
  });

  test('persists every field in Mongo and returns them on a later request', async () => {
    const saved = await request(app).post('/api/profile').send(fullProfile);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ userId: 'default', ...fullProfile });

    // No in-process cache: the stored document is the only source.
    const stored = await UserProfile.findOne({ userId: 'default' }).lean();
    expect(stored.about).toBe(fullProfile.about);
    expect(stored.preferences).toEqual(fullProfile.preferences);

    // GET reads the stored document, not process memory: a change made
    // directly in Mongo (as after a restart) is what the next request returns.
    await UserProfile.updateOne({ userId: 'default' }, { $set: { 'preferences.role': 'Changed in Mongo' } });
    const reloaded = await request(app).get('/api/profile');
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.data).toEqual({
      userId: 'default',
      ...fullProfile,
      preferences: { ...fullProfile.preferences, role: 'Changed in Mongo' }
    });
  });

  test('a partial save keeps the other stored fields', async () => {
    await request(app).post('/api/profile').send(fullProfile);
    const res = await request(app).post('/api/profile').send({ preferences: { style: 'Detailed.' } });

    expect(res.status).toBe(200);
    expect(res.body.data.about).toBe(fullProfile.about);
    expect(res.body.data.preferences).toEqual({ ...fullProfile.preferences, style: 'Detailed.' });
    expect(await UserProfile.countDocuments()).toBe(1);
  });

  test.each([
    ['about is not a string', { about: 42 }, 'about must be a string'],
    ['preferences is not an object', { preferences: 'loud' }, 'preferences must be an object'],
    ['preferences is an array', { preferences: ['x'] }, 'preferences must be an object'],
    ['language is not a string', { preferences: { language: ['fr'] } }, 'preferences.language must be a string'],
    ['role is not a string', { preferences: { role: { a: 1 } } }, 'preferences.role must be a string'],
    ['style is too long', { preferences: { style: 'x'.repeat(1001) } }, 'preferences.style must be at most 1000 characters'],
    ['about is too long', { about: 'x'.repeat(8001) }, 'about must be at most 8000 characters'],
    ['body is an array', [], 'profile must be a JSON object']
  ])('rejects a body where %s', async (_label, body, message) => {
    const res = await request(app).post('/api/profile').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'error', message });
    expect(await UserProfile.countDocuments()).toBe(0);
  });
});
