const express = require('express');
const http = require('http');

jest.mock('../../src/services/roundtable', () => ({
  DEFAULT_PANEL: [],
  DEFAULT_SYNTHESIZER: {},
  COUNCIL_OPTIONS: [],
  getRoundtable: jest.fn(),
  getEmitter: jest.fn()
}));

const roundtableService = require('../../src/services/roundtable');
const { LiveRunEmitter } = require('../../src/services/roundtable/liveRun');
const router = require('../../routes/roundtable');

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/api/roundtable', router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

function parseFrames(text) {
  return text.split('\n\n').filter((frame) => frame.startsWith('event:')).map((frame) => {
    const [eventLine, dataLine] = frame.split('\n');
    return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
  });
}

// Reads the stream until `until(frames)` holds or one second passes, then disconnects.
function readStream(path, until, onOpen = () => {}) {
  return new Promise((resolve, reject) => {
    let body = '';
    const timer = setTimeout(() => { req.destroy(); resolve(parseFrames(body)); }, 1000);
    const req = http.get(`${base}${path}`, (res) => {
      onOpen();
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        const frames = parseFrames(body);
        if (until(frames)) { clearTimeout(timer); req.destroy(); resolve(frames); }
      });
      res.on('end', () => { clearTimeout(timer); resolve(parseFrames(body)); });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
  });
}

describe('GET /api/roundtable/:id/stream', () => {
  test('opens with a snapshot of the round in flight, then streams only later events', async () => {
    const emitter = new LiveRunEmitter();
    emitter.emit('chunk', { type: 'round-start', round: 2 });
    emitter.emit('chunk', { type: 'turn-start', agentId: 'critic', round: 2 });
    emitter.emit('chunk', { type: 'turn-chunk', agentId: 'critic', round: 2, content: 'Partial ' });
    roundtableService.getRoundtable.mockResolvedValue({ _id: 'rt-live', status: 'running' });
    roundtableService.getEmitter.mockReturnValue(emitter);

    const frames = await readStream('/api/roundtable/rt-live/stream',
      (list) => list.some((f) => f.event === 'turn-chunk'),
      () => setImmediate(() => emitter.emit('chunk', { type: 'turn-chunk', agentId: 'critic', round: 2, content: 'answer' })));

    expect(frames[0].event).toBe('snapshot');
    expect(frames[0].data).toMatchObject({
      seq: 3, phase: 'round-2', round: 2,
      agents: { critic: { status: 'running', text: 'Partial ', round: 2 } }
    });
    expect(frames[1]).toEqual({ event: 'turn-chunk', data: expect.objectContaining({ seq: 4, content: 'answer' }) });
  });

  test('a cancelled Council ends the stream at once even while its emitter remains', async () => {
    roundtableService.getRoundtable.mockResolvedValue({ _id: 'rt-x', status: 'cancelled' });
    roundtableService.getEmitter.mockReturnValue(new LiveRunEmitter());
    const frames = await readStream('/api/roundtable/rt-x/stream', () => false);
    expect(frames).toEqual([{ event: 'done', data: expect.objectContaining({ status: 'cancelled' }) }]);
  });
});
