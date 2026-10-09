// A disposable native projection fixture: real store and HTTP handler, no SDK,
// gateway, inference or tool execution. Used only by the Core integration test.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { continuityOperations, continuityHttpHandler } from '../../../integrations/openclaw/super-dad-memory/continuity.js';
import { updateState } from '../../../integrations/openclaw/super-dad-memory/store.js';
import { listenLoopback } from '../../../shared/testing/listenLoopback.js';

const workspace = await mkdtemp(path.join(tmpdir(), 'agentx-native-continuity-http-'));
let reads = 0, current;
const operate = continuityOperations({ workspace, readHistory: async sessionKey => {
  if (reads > 1) throw new Error('Private synthetic sessions.get failure');
  return { sessionKey, messages: [{ role: 'assistant', stopReason: 'stop',
    __openclaw: { runId: current.runId, id: 'synthetic-final' },
    content: [{ type: 'text', text: 'Trois tâches vérifiées.' }] }] };
} });
const handler = continuityHttpHandler(async req => {
  current = req; reads++;
  await updateState(workspace, () => ({ schemaVersion: 1, runs: [{ runId: req.runId, sessionKey: req.sessionKey,
    model: `intermediate-hook-${reads}`, provider: 'synthetic-attempt' }],
  receipts: [{ runId: req.runId, sessionKey: req.sessionKey,
    tool: reads === 1 ? 'list_personal_tasks' : 'personal_memory',
    status: 'verified', observed: true, toolCallId: `fresh-${reads}` }] }));
  return operate(req);
});
const server = createServer(handler);
const address = await listenLoopback(server);
console.log(JSON.stringify({ port: address.port }));
process.once('SIGTERM', () => {
  server.closeAllConnections();
  server.close(async () => { await rm(workspace, { recursive: true }); process.exit(0); });
});
