import { Context } from '@deepseek-ai/cordis';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { buildForkSeed } from '@deepseek-ai/dsh-session';
import { WorkerSessions } from './bridge.mjs';

export const inject = ['sessions', 'sessionPersistence', 'workspaceRegistry', 'connection', 'webServer', 'agentDefaultModel'];
export async function apply(ctx) {
  const workersRoot = process.env.AGENTX_CODING_WORKSPACES;
  if (!workersRoot) return; // Explicit private instance opt-in.
  const stateRoot = process.env.AGENTX_DSH_TEAM_STATE || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'agentx-coding-team');
  if (!isAbsolute(workersRoot) || !isAbsolute(stateRoot)) throw new Error('Coding roots must be absolute');
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const readerContexts = [];
  const bridge = new WorkerSessions({ ctx, workersRoot: await realpath(workersRoot), stateRoot: await realpath(stateRoot),
    reader: async root => {
      const readerContext = new Context();
      readerContexts.push(readerContext);
      await readerContext.plugin(JsonlSessionPersistence.default ?? JsonlSessionPersistence,
        { root, compression: 'none' }).await();
      return readerContext.sessionPersistence;
    }, buildForkSeed });
  const logger = ctx.logger('agentx-coding-team');
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.id.startsWith('session-agentx-worker-')) {
      throw new Error('Worker observation is read-only. Use Reprendre dans une copie.');
    }
  }, { global: true });
  // Native auxiliary providers can react to replayed user/header events too.
  // Fence every observation call, including title generation, before routing.
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId?.startsWith('session-agentx-worker-')) {
      throw new Error('Worker observation cannot request inference');
    }
    return next();
  }, { global: true, prepend: true });
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/agentx-coding', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return Response.json(bridge.list(), { headers: { 'cache-control': 'no-store' } });
        const payload = await request.json();
        if (!payload || Object.keys(payload).sort().join(',') !== 'requestId,sessionId') {
          return Response.json({ error: 'Invalid handoff request' }, { status: 400 });
        }
        return Response.json(await bridge.handoff(payload), { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        logger.warn('Coding session operation failed', error);
        return Response.json({ error: 'La reprise a échoué. Son reçu conserve la demande; réessayez cette même demande.' }, { status: 409 });
      }
    },
  }));
  let stopped = false;
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try { await bridge.poll(); } catch (error) { logger.warn('Worker history refresh failed', error); }
    finally { refreshing = false; }
  };
  void refresh();
  const timer = setInterval(() => { if (!stopped) void refresh(); }, 2000);
  timer.unref();
  ctx.effect(() => async () => { stopped = true; clearInterval(timer); await bridge.pending;
    for (const readerContext of readerContexts) await readerContext.fiber.dispose();
  });
}

export default { inject, apply };
