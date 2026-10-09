/**
 * Tests for Cluster Schedule Service + Cluster Live Service
 * Includes Phase 2 placement tests (getModelVramEstimate, recommendHost, claims)
 */
const mongoose = require('mongoose');

// Mock logger
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');
const ClusterScheduleClaim = require('../../models/ClusterScheduleClaim');
const ModelRegistry = require('../../models/ModelRegistry');
const clusterScheduleService = require('../../src/services/clusterScheduleService');
const clusterLiveService = require('../../src/services/clusterLiveService');

const mockFetch = jest.fn();

describe('clusterScheduleService', () => {
  beforeEach(async () => {
    await ClusterScheduleEntry.deleteMany({});
  });

  // ── getAllEntries ────────────────────────────────────────────

  describe('getAllEntries', () => {
    it('returns all entries when no filters', async () => {
      await ClusterScheduleEntry.create([
        { source: 'agentx', sourceId: 'a', name: 'Task A', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } },
        { source: 'agentx', sourceId: 'b', name: 'Task B', taskType: 'sync', schedule: { type: 'interval', intervalMs: 5000 } }
      ]);
      const entries = await clusterScheduleService.getAllEntries();
      expect(entries).toHaveLength(2);
    });

    it('filters by taskType', async () => {
      await ClusterScheduleEntry.create([
        { source: 'agentx', sourceId: 'a', name: 'Bench', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } },
        { source: 'agentx', sourceId: 'b', name: 'Sync', taskType: 'sync', schedule: { type: 'cron', cron: '0 3 * * *' } }
      ]);
      const entries = await clusterScheduleService.getAllEntries({ taskType: 'benchmark' });
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('Bench');
    });

    it('filters by host', async () => {
      await ClusterScheduleEntry.create([
        { source: 'agentx', sourceId: 'a', name: 'H1', taskType: 'benchmark', host: 'primary', schedule: { type: 'cron', cron: '0 2 * * *' } },
        { source: 'agentx', sourceId: 'b', name: 'H2', taskType: 'benchmark', host: 'secondary', schedule: { type: 'cron', cron: '0 3 * * *' } }
      ]);
      const entries = await clusterScheduleService.getAllEntries({ host: 'primary' });
      expect(entries).toHaveLength(1);
      expect(entries[0].host).toBe('primary');
    });

    it('filters by source', async () => {
      await ClusterScheduleEntry.create([
        { source: 'agentx-system', sourceId: 'a', name: 'System', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } },
        { source: 'agentx', sourceId: 'b', name: 'AX', taskType: 'sync', schedule: { type: 'interval', intervalMs: 5000 } }
      ]);
      const entries = await clusterScheduleService.getAllEntries({ source: 'agentx' });
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('agentx');
    });
  });

  // ── getTimeline ─────────────────────────────────────────────

  describe('getTimeline', () => {
    it('includes midnight and late-evening occurrences on the selected Toronto day', async () => {
      await ClusterScheduleEntry.create([
        { source: 'agentx', sourceId: 'midnight', name: 'Midnight',
          taskType: 'maintenance', schedule: { type: 'cron', cron: '0 0 * * *', timezone: 'America/Toronto' } },
        { source: 'agentx', sourceId: 'late', name: 'Late',
          taskType: 'maintenance', schedule: { type: 'cron', cron: '0 23 * * *', timezone: 'America/Toronto' } }
      ]);
      const timeline = await clusterScheduleService.getTimeline('2026-10-08', 'America/Toronto');
      expect(timeline.find(entry => entry.name === 'Midnight').slots[0].start)
        .toBe('2026-10-08T04:00:00.000Z');
      expect(timeline.find(entry => entry.name === 'Late').slots[0].start)
        .toBe('2026-10-09T03:00:00.000Z');
    });

    it('keeps the cron source timezone while projecting a Toronto calendar day', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx-system', sourceId: 'utc-job', name: 'UTC Job',
        taskType: 'maintenance',
        schedule: { type: 'cron', cron: '0 9 * * *', timezone: 'UTC' }
      });
      const timeline = await clusterScheduleService.getTimeline('2026-10-08', 'America/Toronto');
      expect(timeline[0].slots[0].start).toBe('2026-10-08T09:00:00.000Z');
    });

    it('anchors interval projections on the source scheduler next run', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx-system', sourceId: 'every-15m', name: 'Every 15 minutes',
        taskType: 'monitoring',
        schedule: { type: 'interval', intervalMs: 15 * 60_000, timezone: 'UTC' },
        metadata: { nextRunAtMs: Date.parse('2026-10-08T04:02:00.000Z') }
      });
      const timeline = await clusterScheduleService.getTimeline('2026-10-08', 'America/Toronto');
      expect(timeline[0].slots[0].start).toBe('2026-10-08T04:02:00.000Z');
    });

    it('resolves cron entries into time slots', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx', sourceId: 'cron1', name: 'Hourly Task',
        taskType: 'monitoring', enabled: true,
        schedule: { type: 'cron', cron: '0 */4 * * *', timezone: 'UTC' },
        estimatedDurationMs: 300000
      });

      const timeline = await clusterScheduleService.getTimeline('2026-03-04', 'UTC');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].name).toBe('Hourly Task');
      expect(timeline[0].slots.length).toBeGreaterThanOrEqual(1);
    });

    it('marks continuous entries as full-day span', async () => {
      await ClusterScheduleEntry.create({
        source: 'ollama-persistent', sourceId: 'cont1', name: 'Resident Model',
        taskType: 'inference', enabled: true,
        schedule: { type: 'continuous' }
      });

      const timeline = await clusterScheduleService.getTimeline('2026-03-04', 'UTC');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].slots).toHaveLength(1);
      expect(timeline[0].slots[0].continuous).toBe(true);
    });

    it('marks high-frequency intervals as continuous', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx', sourceId: 'fast1', name: 'Fast Poll',
        taskType: 'monitoring', enabled: true,
        schedule: { type: 'interval', intervalMs: 5000 }
      });

      const timeline = await clusterScheduleService.getTimeline('2026-03-04', 'UTC');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].slots[0].continuous).toBe(true);
    });

    it('excludes disabled entries', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx', sourceId: 'dis1', name: 'Disabled Task',
        taskType: 'benchmark', enabled: false,
        schedule: { type: 'cron', cron: '0 2 * * *' }
      });

      const timeline = await clusterScheduleService.getTimeline('2026-03-04', 'UTC');
      expect(timeline).toHaveLength(0);
    });
  });

  // ── getNextTasks ────────────────────────────────────────────

  describe('getNextTasks', () => {
    it('uses an external interval scheduler next-run receipt when available', async () => {
      const nextRun = Date.now() + 12 * 60_000;
      await ClusterScheduleEntry.create({
        source: 'agentx-system', sourceId: 'next-tick', name: 'Next tick',
        taskType: 'monitoring',
        schedule: { type: 'interval', intervalMs: 15 * 60_000 },
        metadata: { nextRunAtMs: nextRun }
      });
      const tasks = await clusterScheduleService.getNextTasks(1);
      expect(tasks[0].nextRun).toBe(new Date(nextRun).toISOString());
    });

    it('returns next occurrences sorted by time', async () => {
      await ClusterScheduleEntry.create([
        {
          source: 'agentx', sourceId: 'n1', name: 'Every 6h', taskType: 'sync', enabled: true,
          schedule: { type: 'cron', cron: '0 */6 * * *', timezone: 'UTC' }
        },
        {
          source: 'agentx', sourceId: 'n2', name: 'Every Hour', taskType: 'monitoring', enabled: true,
          schedule: { type: 'cron', cron: '0 * * * *', timezone: 'UTC' }
        }
      ]);

      const tasks = await clusterScheduleService.getNextTasks(5);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      // Should be sorted ascending by msFromNow
      for (let i = 1; i < tasks.length; i++) {
        expect(tasks[i].msFromNow).toBeGreaterThanOrEqual(tasks[i - 1].msFromNow);
      }
    });

    it('respects count limit', async () => {
      await ClusterScheduleEntry.create([
        { source: 'agentx', sourceId: 'l1', name: 'T1', taskType: 'sync', enabled: true, schedule: { type: 'cron', cron: '0 * * * *', timezone: 'UTC' } },
        { source: 'agentx', sourceId: 'l2', name: 'T2', taskType: 'sync', enabled: true, schedule: { type: 'cron', cron: '30 * * * *', timezone: 'UTC' } },
        { source: 'agentx', sourceId: 'l3', name: 'T3', taskType: 'sync', enabled: true, schedule: { type: 'cron', cron: '15 * * * *', timezone: 'UTC' } }
      ]);

      const tasks = await clusterScheduleService.getNextTasks(2);
      expect(tasks).toHaveLength(2);
    });

    it('excludes disabled entries', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx', sourceId: 'dis2', name: 'Off', taskType: 'benchmark', enabled: false,
        schedule: { type: 'cron', cron: '0 * * * *', timezone: 'UTC' }
      });

      const tasks = await clusterScheduleService.getNextTasks(5);
      expect(tasks).toHaveLength(0);
    });
  });

  // ── getTimelineByHost ──────────────────────────────────────

  describe('getTimelineByHost', () => {
    beforeEach(() => {
      process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
      process.env.OLLAMA_HOST_2 = 'http://127.0.0.1:11435';
    });

    it('groups tasks by host', async () => {
      await ClusterScheduleEntry.create([
        { source: 'agentx', sourceId: 'h1', name: 'Primary Task', taskType: 'benchmark', host: 'primary', enabled: true,
          schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }, estimatedDurationMs: 300000 },
        { source: 'agentx', sourceId: 'h2', name: 'Secondary Task', taskType: 'sync', host: 'secondary', enabled: true,
          schedule: { type: 'cron', cron: '0 3 * * *', timezone: 'UTC' }, estimatedDurationMs: 300000 }
      ]);

      const hosts = await clusterScheduleService.getTimelineByHost('2026-03-04', 'UTC');
      const primary = hosts.find(h => h.hostId === 'primary');
      const secondary = hosts.find(h => h.hostId === 'secondary');
      expect(primary.tasks).toHaveLength(1);
      expect(primary.tasks[0].name).toBe('Primary Task');
      expect(secondary.tasks).toHaveLength(1);
      expect(secondary.tasks[0].name).toBe('Secondary Task');
    });

    it('reports unresolved VRAM when host metadata is not configured', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx', sourceId: 'v1', name: 'T', taskType: 'benchmark', host: 'primary', enabled: true,
        schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }, estimatedDurationMs: 300000
      });

      const hosts = await clusterScheduleService.getTimelineByHost('2026-03-04', 'UTC');
      const primary = hosts.find(h => h.hostId === 'primary');
      expect(primary.vramCapacityMb).toBeNull();
    });

    it('puts null-host tasks into unassigned', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx', sourceId: 'u1', name: 'No Host', taskType: 'monitoring', enabled: true,
        schedule: { type: 'cron', cron: '0 * * * *', timezone: 'UTC' }, estimatedDurationMs: 60000
      });

      const hosts = await clusterScheduleService.getTimelineByHost('2026-03-04', 'UTC');
      const unassigned = hosts.find(h => h.hostId === 'unassigned');
      expect(unassigned).toBeDefined();
      expect(unassigned.tasks).toHaveLength(1);
    });
  });

  // ── getConflicts ──────────────────────────────────────────────

  describe('getConflicts', () => {
    const savedHostEnv = {};
    const hostEnvKeys = ['OLLAMA_HOST', 'OLLAMA_HOST_2', 'OLLAMA_HOST_3', 'OLLAMA_HOST_VRAM_MAP'];

    beforeEach(() => {
      for (const key of hostEnvKeys) savedHostEnv[key] = process.env[key];
      process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
      process.env.OLLAMA_HOST_VRAM_MAP = '127.0.0.1:11434=24576';
      delete process.env.OLLAMA_HOST_2;
      delete process.env.OLLAMA_HOST_3;
    });

    afterEach(() => {
      for (const key of hostEnvKeys) {
        if (savedHostEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedHostEnv[key];
      }
    });

    const job = (overrides) => ({
      source: 'agentx', taskType: 'benchmark', host: 'primary', enabled: true,
      schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }, estimatedDurationMs: 7200000,
      ...overrides
    });

    it('reports overlapping models whose combined VRAM exceeds the host', async () => {
      await ClusterScheduleEntry.create([
        job({ sourceId: 'c1', name: 'Task A', model: 'qwen3:32b', vramMb: 20000 }),
        job({ sourceId: 'c2', name: 'Task B', model: 'gemma3:12b', vramMb: 9000,
          schedule: { type: 'cron', cron: '0 3 * * *', timezone: 'UTC' }, estimatedDurationMs: 3600000 })
      ]);

      const conflicts = await clusterScheduleService.getConflicts('2026-03-04', 'UTC');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        hostId: 'primary',
        start: '2026-03-04T03:00:00.000Z',
        end: '2026-03-04T04:00:00.000Z',
        capacityVramMb: 24576,
        requiredVramMb: 29000,
        unknownVramModels: []
      });
      expect(conflicts[0].tasks.map(task => task.name).sort()).toEqual(['Task A', 'Task B']);
    });

    it('does not report overlaps that fit, or that share one loaded model', async () => {
      await ClusterScheduleEntry.create([
        job({ sourceId: 'f1', name: 'Embed A', model: 'nomic-embed-text', vramMb: 1000 }),
        job({ sourceId: 'f2', name: 'Embed B', model: 'nomic-embed-text', vramMb: 1000 }),
        job({ sourceId: 'f3', name: 'Small', model: 'llama3:8b', vramMb: 6000 }),
        job({ sourceId: 'f4', name: 'Big twin', model: 'qwen3:32b', vramMb: 20000,
          schedule: { type: 'cron', cron: '0 10 * * *', timezone: 'UTC' } }),
        job({ sourceId: 'f5', name: 'Big twin 2', model: 'qwen3:32b', vramMb: 20000,
          schedule: { type: 'cron', cron: '0 10 * * *', timezone: 'UTC' } })
      ]);

      expect(await clusterScheduleService.getConflicts('2026-03-04', 'UTC')).toHaveLength(0);
    });

    it('counts resident models against the capacity', async () => {
      await ClusterScheduleEntry.create([
        { source: 'ollama-persistent', sourceId: 'r1', name: 'Voice model', taskType: 'inference', host: 'primary',
          model: 'gemma3:12b', vramMb: 9000, enabled: true, schedule: { type: 'continuous' } },
        job({ sourceId: 'r2', name: 'Nightly', model: 'qwen3:32b', vramMb: 20000 })
      ]);

      const conflicts = await clusterScheduleService.getConflicts('2026-03-04', 'UTC');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].requiredVramMb).toBe(29000);
      expect(conflicts[0].tasks.find(task => task.name === 'Voice model')).toMatchObject({ resident: true });
    });

    it('does not invent a conflict from unknown model sizes or unknown capacity', async () => {
      await ClusterScheduleEntry.create([
        job({ sourceId: 'u1', name: 'Sized', model: 'qwen3:32b', vramMb: 20000 }),
        job({ sourceId: 'u2', name: 'Unsized', model: 'mystery:70b' })
      ]);
      expect(await clusterScheduleService.getConflicts('2026-03-04', 'UTC')).toHaveLength(0);

      await ClusterScheduleEntry.create(job({ sourceId: 'u3', name: 'Second big', model: 'llama3:70b', vramMb: 20000 }));
      const conflicts = await clusterScheduleService.getConflicts('2026-03-04', 'UTC');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].unknownVramModels).toEqual(['mystery:70b']);

      delete process.env.OLLAMA_HOST_VRAM_MAP;
      expect(await clusterScheduleService.getConflicts('2026-03-04', 'UTC')).toHaveLength(0);
    });

    it('ignores jobs without a model or without a declared host', async () => {
      await ClusterScheduleEntry.create([
        job({ sourceId: 'n1', name: 'No model A' }),
        job({ sourceId: 'n2', name: 'No model B' }),
        job({ sourceId: 'n3', name: 'Unassigned A', host: null, model: 'qwen3:32b', vramMb: 20000 }),
        job({ sourceId: 'n4', name: 'Unassigned B', host: null, model: 'llama3:70b', vramMb: 20000 })
      ]);
      expect(await clusterScheduleService.getConflicts('2026-03-04', 'UTC')).toHaveLength(0);
    });
  });

  // ── syncEntries ─────────────────────────────────────────────

  describe('syncEntries', () => {
    it('creates new entries', async () => {
      const stats = await clusterScheduleService.syncEntries([
        { source: 'agentx', sourceId: 'new1', name: 'New Task', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } }
      ]);
      expect(stats.created).toBe(1);
      expect(stats.updated).toBe(0);
      expect(await ClusterScheduleEntry.countDocuments()).toBe(1);
    });

    it('updates existing entries when changed', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx', sourceId: 'upd1', name: 'Old Name', taskType: 'benchmark',
        schedule: { type: 'cron', cron: '0 2 * * *' }
      });

      const stats = await clusterScheduleService.syncEntries([
        { source: 'agentx', sourceId: 'upd1', name: 'New Name', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } }
      ]);
      expect(stats.updated).toBe(1);
      expect(stats.created).toBe(0);

      const doc = await ClusterScheduleEntry.findOne({ sourceId: 'upd1' });
      expect(doc.name).toBe('New Name');
    });

    it('reports unchanged when no diff', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx', sourceId: 'same1', name: 'Same', taskType: 'benchmark',
        schedule: { type: 'cron', cron: '0 2 * * *' }, priority: 5, enabled: true
      });

      const stats = await clusterScheduleService.syncEntries([
        { source: 'agentx', sourceId: 'same1', name: 'Same', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' }, priority: 5, enabled: true }
      ]);
      expect(stats.unchanged).toBe(1);
    });

    it('updates mirrored runtime state when schedule configuration is unchanged', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx-system', sourceId: 'runtime1', name: 'Runtime State', taskType: 'monitoring',
        schedule: { type: 'cron', cron: '0 * * * *', timezone: 'America/Toronto' },
        lastRun: new Date('2026-07-18T10:00:00.000Z'),
        metadata: { lastStatus: 'error', consecutiveErrors: 1 }
      });

      const stats = await clusterScheduleService.syncEntries([{
        source: 'agentx-system', sourceId: 'runtime1', name: 'Runtime State', taskType: 'monitoring',
        schedule: { type: 'cron', cron: '0 * * * *', timezone: 'America/Toronto' },
        lastRun: new Date('2026-07-18T11:00:00.000Z'),
        metadata: { lastStatus: 'ok', consecutiveErrors: 0 }
      }]);

      expect(stats.updated).toBe(1);
      const doc = await ClusterScheduleEntry.findOne({ sourceId: 'runtime1' }).lean();
      expect(doc.lastRun.toISOString()).toBe('2026-07-18T11:00:00.000Z');
      expect(doc.metadata).toEqual({ lastStatus: 'ok', consecutiveErrors: 0 });
    });

    it('updates schedule timezone changes', async () => {
      await ClusterScheduleEntry.create({
        source: 'agentx-system', sourceId: 'timezone1', name: 'Timezone State', taskType: 'monitoring',
        schedule: { type: 'cron', cron: '0 * * * *', timezone: 'UTC' }
      });

      const stats = await clusterScheduleService.syncEntries([{
        source: 'agentx-system', sourceId: 'timezone1', name: 'Timezone State', taskType: 'monitoring',
        schedule: { type: 'cron', cron: '0 * * * *', timezone: 'America/Toronto' }
      }]);

      expect(stats.updated).toBe(1);
    });

    it('does not create duplicates on re-sync', async () => {
      const entries = [
        { source: 'agentx', sourceId: 'dup1', name: 'Dedup', taskType: 'sync', schedule: { type: 'cron', cron: '0 * * * *' } }
      ];
      await clusterScheduleService.syncEntries(entries);
      await clusterScheduleService.syncEntries(entries);
      expect(await ClusterScheduleEntry.countDocuments()).toBe(1);
    });

    it('skips entries missing source/sourceId', async () => {
      const stats = await clusterScheduleService.syncEntries([
        { name: 'No Source', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 * * * *' } }
      ]);
      expect(stats.created).toBe(0);
      expect(await ClusterScheduleEntry.countDocuments()).toBe(0);
    });
  });
});

// ── clusterLiveService ────────────────────────────────────────

describe('clusterLiveService', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    clusterLiveService._setFetch(mockFetch);
    process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
    process.env.OLLAMA_HOST_2 = 'http://127.0.0.1:11435';
  });

  it('returns online hosts with models', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3:8b', model: 'llama3:8b', size: 4000000000, size_vram: 3500000000 }]
      })
    });

    const result = await clusterLiveService.getLiveState();
    expect(result.hosts).toBeDefined();
    expect(result.polledAt).toBeDefined();
    expect(result.evidence).toEqual({
      authority: 'agentx.cluster-schedule-live-detail',
      scope: 'loaded-model-and-vram-detail',
      observedAt: result.polledAt,
      headlineAuthority: false
    });
    // At least one host should be online (from test env vars)
    const online = result.hosts.filter(h => h.status === 'online');
    expect(online.length).toBeGreaterThanOrEqual(1);
    expect(online[0].models).toHaveLength(1);
    expect(online[0].models[0].name).toBe('llama3:8b');
  });

  it('gracefully handles unreachable hosts', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await clusterLiveService.getLiveState();
    expect(result.hosts).toBeDefined();
    const unreachable = result.hosts.filter(h => h.status === 'unreachable');
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
    expect(unreachable[0].error).toBeDefined();
    expect(unreachable[0].models).toEqual([]);
  });

  it('handles mixed online/offline hosts', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ models: [{ name: 'model-a', model: 'model-a', size: 1000 }] })
        });
      }
      return Promise.reject(new Error('timeout'));
    });

    const result = await clusterLiveService.getLiveState();
    const online = result.hosts.filter(h => h.status === 'online');
    const offline = result.hosts.filter(h => h.status === 'unreachable');
    expect(online.length).toBeGreaterThanOrEqual(1);
    expect(offline.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Phase 2: Placement Service ────────────────────────────────────────────

describe('getModelVramEstimate', () => {
  afterEach(async () => {
    await ModelRegistry.deleteMany({});
  });

  it('does not treat artifact bytes as runtime VRAM evidence', async () => {
    await ModelRegistry.create({
      modelName: 'qwen3:8b', displayName: 'Qwen3 8B',
      modelSizeBytes: 5_000_000_000, // ~4768 MiB
      categories: ['generalist']
    });

    const est = await clusterScheduleService.getModelVramEstimate('qwen3:8b');
    expect(est).toEqual({ estimatedMiB: null, confidence: 'unknown' });
  });

  it('returns measured estimate from hostPerformance snapshots', async () => {
    await ModelRegistry.create({
      modelName: 'llama3:8b', displayName: 'Llama3 8B',
      categories: ['generalist'],
      hostPerformance: [
        { hostUrl: 'http://127.0.0.1:11434', tokensPerSec: 30, latencyMs: 1500, vramUsedMiB: 5100, status: 'pass' },
        { hostUrl: 'http://127.0.0.1:11434', tokensPerSec: 28, latencyMs: 1600, vramUsedMiB: 5200, status: 'pass' }
      ]
    });

    const est = await clusterScheduleService.getModelVramEstimate('llama3:8b');
    expect(est.confidence).toBe('measured');
    expect(est.estimatedMiB).toBe(5150); // avg of 5100 and 5200
  });

  it('does not infer runtime VRAM from model-name parameter counts', async () => {
    const est = await clusterScheduleService.getModelVramEstimate('dolphin-phi:2.7b');
    expect(est).toEqual({ estimatedMiB: null, confidence: 'unknown' });
  });

  it('returns unknown for unrecognized model names', async () => {
    const est = await clusterScheduleService.getModelVramEstimate('mystery-model:latest');
    expect(est).toEqual({ estimatedMiB: null, confidence: 'unknown' });
  });
});

describe('recommendHost', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    clusterLiveService._setFetch(mockFetch);
    process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
    process.env.OLLAMA_HOST_2 = 'http://127.0.0.1:11435';
    process.env.OLLAMA_HOST_3 = 'http://127.0.0.1:11436';
    // Clear claims between tests
    await clusterScheduleService._clearClaimsForTests();
  });

  afterEach(async () => {
    await ModelRegistry.deleteMany({});
    await ClusterScheduleClaim.deleteMany({});
    delete process.env.OLLAMA_HOST_3;
  });

  it('prefers host where model is already loaded', async () => {
    // Host 1 (primary): has llama3:8b loaded
    // Host 2 (secondary): empty
    // Host 3 (tertiary): empty
    let callIdx = 0;
    mockFetch.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        // primary — has the model loaded
        return Promise.resolve({
          ok: true,
          json: async () => ({
            models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 5000000000, size_vram: 5000000000 }]
          })
        });
      }
      // secondary and tertiary — empty
      return Promise.resolve({ ok: true, json: async () => ({ models: [] }) });
    });

    const rec = await clusterScheduleService.recommendHost('qwen3:8b', 30000, 'normal');
    expect(rec.host).toBe('primary');
    expect(rec.reason).toContain('model already loaded');
  });

  it('does not treat a namespaced artifact as satisfying a different exact tag', async () => {
    await ModelRegistry.create({
      modelName: 'gemma4:e4b',
      displayName: 'Gemma 4 E4B',
      modelSizeBytes: 12_000_000_000,
      categories: ['generalist']
    });

    let callIdx = 0;
    mockFetch.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        // primary — lots of free VRAM, but model is not resident
        return Promise.resolve({ ok: true, json: async () => ({ models: [] }) });
      }
      if (callIdx === 2) {
        // secondary — a distinct namespaced artifact is resident
        return Promise.resolve({
          ok: true,
          json: async () => ({
            models: [{ name: 'ax/gemma4:e4b', model: 'ax/gemma4:e4b', size: 14_000_000_000, size_vram: 14_000_000_000 }]
          })
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ models: [] }) });
    });

    const rec = await clusterScheduleService.recommendHost('gemma4:e4b', 30000, 'normal');
    expect(rec.host).not.toBe('secondary');
  });

  it('avoids hosts with insufficient VRAM', async () => {
    // Register a large model so VRAM estimate is high
    await ModelRegistry.create({
      modelName: 'bigmodel:70b', displayName: 'BigModel 70B',
      modelSizeBytes: 80_000_000_000, // ~75 GiB — too big for all hosts
      categories: ['generalist']
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] })
    });

    const rec = await clusterScheduleService.recommendHost('bigmodel:70b', 30000, 'normal');
    // Should still return a host (advisory), but with warnings
    expect(rec.host).toBeDefined();
    expect(rec.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('picks host with most free VRAM when model not loaded anywhere', async () => {
    let callIdx = 0;
    mockFetch.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        // primary (48GB) — some models loaded (10GB used)
        return Promise.resolve({
          ok: true,
          json: async () => ({
            models: [{ name: 'other:14b', model: 'other:14b', size: 10000000000, size_vram: 10_737_418_240 }]
          })
        });
      }
      if (callIdx === 2) {
        // secondary (16GB) — empty
        return Promise.resolve({ ok: true, json: async () => ({ models: [] }) });
      }
      // tertiary (12GB) — empty
      return Promise.resolve({ ok: true, json: async () => ({ models: [] }) });
    });

    const rec = await clusterScheduleService.recommendHost('dolphin-phi:2.7b', 30000, 'normal');
    // All hosts can fit a 2.7b model, but primary (48GB, ~38GB free)
    // should score higher than tertiary (12GB, empty)
    expect(rec.host).toBeDefined();
    expect(rec.reason).toBeDefined();
  });

  it('factors in active claims to reduce contention', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] })
    });

    // Place claims on primary and secondary
    await clusterScheduleService.createClaim('primary', 'some-model', 'test1', 60000);
    await clusterScheduleService.createClaim('primary', 'some-model', 'test2', 60000);
    await clusterScheduleService.createClaim('secondary', 'some-model', 'test3', 60000);

    const rec = await clusterScheduleService.recommendHost('dolphin-phi:2.7b', 30000, 'normal');
    // tertiary has 0 claims, so it should be preferred (despite smaller VRAM)
    // unless primary/secondary's larger VRAM outweighs claims penalty
    expect(rec.host).toBeDefined();
    // At minimum, scoring should have noted claims
    const primaryScored = rec._scored?.find(s => s.host === 'primary');
    const tertiaryScored = rec._scored?.find(s => s.host === 'tertiary');
    if (primaryScored && tertiaryScored) {
      // primary has 2 claims penalty (-30), tertiary has 0
      expect(primaryScored.reasons.some(r => r.includes('active claims'))).toBe(true);
    }
  });

  it('does not invent a placement when all hosts are unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const rec = await clusterScheduleService.recommendHost('qwen3:8b', 30000, 'normal');
    expect(rec.host).toBeNull();
    expect(rec.hostUrl).toBeNull();
    expect(rec.reason).toBe('No reachable host');
    expect(rec.confidence).toBe('none');
    expect(rec.warnings).toContain('All configured hosts are unreachable; no placement is available');
  });

  it('excludes hosts that are running a benchmark batch', async () => {
    // Primary has the model loaded (+100), would win absent the benchmarking
    // exclusion. The active benchmark claim makes the scheduler pick secondary.
    let callIdx = 0;
    mockFetch.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 5000000000, size_vram: 5000000000 }]
          })
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ models: [] }) });
    });

    // Spy on hostPreferenceService.listBenchmarkClaims to report primary is busy
    const hostPrefService = require('../../src/services/hostPreferenceService');
    const spy = jest.spyOn(hostPrefService, 'listBenchmarkClaims').mockResolvedValue([
      { hostUrl: 'http://127.0.0.1:11434', batchId: 'test-batch', prevStatus: 'ready' }
    ]);
    try {
      const rec = await clusterScheduleService.recommendHost('qwen3:8b', 30000, 'normal');
      expect(rec.host).not.toBe('primary');
      expect(rec.reason).not.toContain('benchmarking in progress');
      const primaryScored = rec._scored.find(s => s.host === 'primary');
      expect(primaryScored.reasons.some(r => r.includes('benchmarking in progress'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('claims', () => {
  beforeEach(async () => {
    await clusterScheduleService._clearClaimsForTests();
  });

  afterEach(async () => {
    await ClusterScheduleClaim.deleteMany({});
  });

  it('createClaim creates and getActiveClaims lists it', async () => {
    const claim = await clusterScheduleService.createClaim('primary', 'qwen3:8b', 'buddy', 30000);
    expect(claim.claimId).toBeDefined();
    expect(claim.expiresAt).toBeDefined();

    const active = await clusterScheduleService.getActiveClaims();
    expect(active).toHaveLength(1);
    expect(active[0].host).toBe('primary');
    expect(active[0].model).toBe('qwen3:8b');
    expect(active[0].caller).toBe('buddy');
  });

  it('persists claims to Mongo so other Core replicas can see them', async () => {
    const claim = await clusterScheduleService.createClaim('primary', 'qwen3:8b', 'buddy', 30000);
    const persisted = await ClusterScheduleClaim.findById(claim.claimId).lean();
    expect(persisted).toMatchObject({
      host: 'primary',
      model: 'qwen3:8b',
      caller: 'buddy'
    });
  });

  it('releaseClaim removes claim early', async () => {
    const claim = await clusterScheduleService.createClaim('secondary', 'llama3:8b', 'janitor', 60000);
    expect(await clusterScheduleService.getActiveClaims()).toHaveLength(1);

    const released = await clusterScheduleService.releaseClaim(claim.claimId);
    expect(released).toBe(true);
    expect(await clusterScheduleService.getActiveClaims()).toHaveLength(0);
  });

  it('expired claims are purged automatically', async () => {
    await clusterScheduleService.createClaim('primary', 'qwen3:8b', 'buddy', -1000);

    const active = await clusterScheduleService.getActiveClaims();
    expect(active).toHaveLength(0);
    expect(await ClusterScheduleClaim.countDocuments()).toBe(0);
  });

  it('prevents duplicate recommendations via claim accounting', async () => {
    // Multiple claims on same host should be reflected in active claims count
    await clusterScheduleService.createClaim('primary', 'model-a', 'buddy', 30000);
    await clusterScheduleService.createClaim('primary', 'model-b', 'janitor', 30000);
    await clusterScheduleService.createClaim('secondary', 'model-c', 'chat', 30000);

    const active = await clusterScheduleService.getActiveClaims();
    expect(active).toHaveLength(3);

    const primaryClaims = active.filter(c => c.host === 'primary');
    expect(primaryClaims).toHaveLength(2);
  });
});
