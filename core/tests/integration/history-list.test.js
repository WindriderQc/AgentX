const express = require('express');
const Conversation = require('../../models/Conversation');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

const OWNER = 'history-list-owner';
let harness;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.user = { userId: OWNER };
    next();
  });
  app.use('/api/history', require('../../routes/history'));
  harness = await startTestHttpHarness(app, {
    maxSockets: 4,
    transport: process.platform === 'win32' ? 'pipe' : 'tcp'
  });
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => { await Conversation.deleteMany({ userId: OWNER }); });

const HIDDEN = [
  { tags: ['agentx:internal-probe'] },
  { source: 'external', clientRef: 'benchmark-canary:fixture' },
  { title: 'Reply exactly FINAL_CORE_FIXTURE_OK' }
];

// 55 visible conversations with a hidden internal one between each, newest first.
async function seedInterleaved() {
  const base = Date.UTC(2026, 0, 1);
  const docs = [];
  for (let i = 0; i < 55; i += 1) {
    docs.push({
      userId: OWNER, title: `Visible ${i}`, model: 'fixture-model',
      updatedAt: new Date(base - i * 2000),
      messages: Array.from({ length: (i % 3) + 1 }, (_, n) => ({
        role: n % 2 === 0 ? 'user' : 'assistant', content: `Fixture ${i} message ${n}`
      }))
    });
    docs.push({
      userId: OWNER, title: `Hidden ${i}`, model: 'fixture-model',
      updatedAt: new Date(base - i * 2000 + 1000),
      messages: [{ role: 'user', content: 'Internal fixture' }],
      ...HIDDEN[i % HIDDEN.length]
    });
  }
  await Conversation.insertMany(docs);
}

test('history list fills a full page of visible rows with correct previews', async () => {
  await seedInterleaved();
  const response = await harness.request.get('/api/history').expect(200);
  const rows = response.body.data;
  expect(rows).toHaveLength(50);
  expect(rows.every(row => row.title.startsWith('Visible '))).toBe(true);
  expect(rows[0]).toEqual({
    id: expect.any(String),
    title: 'Visible 0',
    date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    model: 'fixture-model',
    preview: 'Fixture 0 message 0...',
    qualityScore: null
  });
  expect(rows[2].preview).toBe('Fixture 2 message 2...');
});

test('conversations alias fills a full page with correct message counts', async () => {
  await seedInterleaved();
  const response = await harness.request.get('/api/history/conversations').expect(200);
  const rows = response.body.data;
  expect(rows).toHaveLength(50);
  expect(rows.every(row => row.title.startsWith('Visible '))).toBe(true);
  expect(rows.slice(0, 3).map(row => row.messageCount)).toEqual([1, 2, 3]);
  expect(Object.keys(rows[0]).sort()).toEqual(['date', 'id', 'messageCount', 'model', 'title']);
});
