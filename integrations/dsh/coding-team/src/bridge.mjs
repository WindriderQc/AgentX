import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyWorkspace, discoverWorkers } from './workspaces.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

/** Native runtime transport only. Core retains task state, review and dispatch authority. */
export class WorkerSessions {
  constructor({ ctx, reader, workersRoot, stateRoot, buildForkSeed }) {
    Object.assign(this, { ctx, reader, workersRoot, stateRoot, buildForkSeed });
    this.records = new Map();
    this.readers = new Map();
    this.pending = Promise.resolve();
    this.error = undefined;
    this.initialized = false;
  }
  serialize(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  async poll() {
    return this.serialize(async () => {
      try {
        for (const worker of await discoverWorkers(this.workersRoot)) {
          let backend = this.readers.get(worker.logs);
          if (!backend) {
            backend = this.reader(worker.logs);
            this.readers.set(worker.logs, backend);
          }
          for (const stored of await backend.list()) {
            const key = `${worker.taskId}:${stored.header.id}`;
            let record = this.records.get(key);
            if (record?.revision === stored.revision) { record.updatedAt = Date.now(); continue; }
            const handle = await backend.open(stored.header.id, 'read');
            let events;
            try { ({ events } = await handle.read()); } finally { await handle.close(); }
            if (!events.length) continue;
            if (!record) {
              // Observation is ephemeral: the original native log is its durable owner.
              // Reconstruct from that owner after restart, never from a second task store.
              const id = `session-agentx-worker-${digest(key).slice(0, 24)}`;
              const cwd = join(this.stateRoot, 'observers', worker.taskId);
              await mkdir(cwd, { recursive: true, mode: 0o700 });
              const workspace = await this.ctx.workspaceRegistry.create(cwd, `Coding Team · ${worker.taskId}`);
              const session = this.ctx.sessions.create(id, { seed: events, meta: {
                cwd, createdAt: stored.header.createdAt,
              } });
              record = { ...worker, sourceId: stored.header.id, id, session, events: [...events],
                sourceToView: events.map(event => event.seq), error: undefined };
              this.records.set(key, record);
              await workspace.attachSession(id);
            } else {
              if (events.length < record.events.length || digest(events.slice(0, record.events.length)) !== digest(record.events)) {
                record.error = 'Source history changed; synchronization stopped';
                continue;
              }
              for (const event of events.slice(record.events.length)) {
                // A worker restart normally creates a new native session. Refuse an
                // unexpected seed boundary rather than forge a constructor-owned marker.
                if (event.type === 'session/end-seed') {
                  record.error = 'Worker lifecycle changed; restart the bridge to reload its history';
                  break;
                }
                const mapped = structuredClone(event);
                const translate = seq => record.sourceToView[seq] ?? (() => { throw new Error('Invalid event reference'); })();
                if (mapped.sourceEventSeqs) mapped.sourceEventSeqs = mapped.sourceEventSeqs.map(translate);
                if (typeof mapped.surfaceOp === 'object') {
                  mapped.surfaceOp.startSeq = translate(mapped.surfaceOp.startSeq);
                  mapped.surfaceOp.endSeq = translate(mapped.surfaceOp.endSeq);
                }
                if (mapped.type === 'session/title') mapped.data.messageSeqs = mapped.data.messageSeqs.map(translate);
                if (mapped.type === 'developer/message' && mapped.data.headerSeq !== undefined) {
                  mapped.data.headerSeq = translate(mapped.data.headerSeq);
                }
                record.sourceToView.push(record.session.seq);
                record.session.append(mapped.type, mapped.data, ...(mapped.surfaceOp === undefined ? [] : [{
                  surfaceOp: mapped.surfaceOp, ...(mapped.sourceEventSeqs ? { sourceEventSeqs: mapped.sourceEventSeqs } : {}),
                }]));
                record.events.push(event);
              }
            }
            record.revision = stored.revision;
            record.updatedAt = Date.now();
          }
        }
        this.error = undefined;
        this.initialized = true;
      } catch (error) {
        this.error = 'Actualisation des historiques indisponible';
        throw error;
      }
    });
  }
  list() {
    return { error: this.error ?? null, loading: !this.initialized, sessions: [...this.records.values()].sort((left, right) =>
      (right.events.at(-1)?.time ?? 0) - (left.events.at(-1)?.time ?? 0)).map(record => ({
      sessionId: record.id, taskId: record.taskId, sourceId: record.sourceId,
      eventCount: record.events.length, updatedAt: record.updatedAt,
      lastEventAt: record.events.at(-1)?.time ?? null, error: record.error ?? null,
      turnOpen: record.events.reduce((open, event) => event.type === 'turn/start' ? true
        : event.type === 'turn/end' ? false : open, false),
    })) };
  }
  isObserver(id) { return [...this.records.values()].some(record => record.id === id); }
  async handoff({ sessionId, requestId }) {
    if (!uuid.test(requestId ?? '')) throw new Error('A stable request UUID is required');
    return this.serialize(async () => {
      const record = [...this.records.values()].find(item => item.id === sessionId);
      if (!record) throw new Error('Unknown worker session');
      const directory = join(this.stateRoot, 'handoffs', requestId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const receiptPath = join(directory, 'receipt.json');
      let receipt = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (receipt) {
        if (receipt.sourceId !== record.sourceId || receipt.taskId !== record.taskId) throw new Error('Request identity conflict');
        if (receipt.state === 'ready') return receipt;
        throw new Error('Previous handoff is incomplete; inspect its receipt before retrying');
      }
      const save = async () => {
        await writeFile(`${receiptPath}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flush: true });
        await rename(`${receiptPath}.tmp`, receiptPath);
      };
      receipt = { state: 'preparing', taskId: record.taskId, sourceId: record.sourceId,
        requestId, sessionId: `session-${randomUUID()}`, cwd: join(directory, 'workspace'),
        sourceEventCount: record.events.length, sourceHash: digest(record.events), createdAt: Date.now() };
      await save();
      try {
        receipt.files = await copyWorkspace(record.workspace, receipt.cwd);
        const seed = this.buildForkSeed(record.events, record.events.length - 1);
        // Native fork closers preserve incomplete calls without resending them.
        const session = this.ctx.sessions.prepare(receipt.sessionId, { seed,
          inheritedEventCount: record.events.length, meta: { cwd: receipt.cwd,
            parentSession: record.sourceId, isSeeded: true } });
        const selection = session.append('model/selection', this.ctx.agentDefaultModel.currentSelection());
        const notice = session.append('user/message', { id: `message-${randomUUID()}`, role: 'user',
          source: { kind: 'agentx-handoff', form: 'notice', summary: 'Continuation humaine dans une copie indépendante.' },
          content: [{ type: 'text', text: `Runtime handoff: this is an independent human continuation of task ${record.taskId}. `
            + `Its current working directory is ${receipt.cwd}. Historical /workspace paths describe the original worker. `
            + 'Use paths relative to this copy. Files were copied at handoff time, not at the historical event boundary. '
            + 'The original worker retains its own execution. This continuation does not approve, stop or deploy its task. '
            + 'A rejected candidate may remain in refs/stash; inspect it before applying it.' }],
        }, { surfaceOp: 'append' });
        const handle = await this.ctx.sessionPersistence.create(session.header, { inheritedEventCount: record.events.length });
        try { await handle.append([...seed, selection, notice]); await handle.flush(); } finally { await handle.close(); }
        const workspace = await this.ctx.workspaceRegistry.create(receipt.cwd, `Reprise · ${record.taskId}`);
        await workspace.attachSession(receipt.sessionId);
        receipt.state = 'ready';
        await save();
        return receipt;
      } catch (error) {
        receipt.state = 'incomplete';
        await save();
        throw error;
      }
    });
  }
}
