/**
 * Tests for Cluster Schedule Service + Cluster Live Service
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
        { source: 'n8n', sourceId: 'a', name: 'Task A', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } },
        { source: 'agentx', sourceId: 'b', name: 'Task B', taskType: 'sync', schedule: { type: 'interval', intervalMs: 5000 } }
      ]);
      const entries = await clusterScheduleService.getAllEntries();
      expect(entries).toHaveLength(2);
    });

    it('filters by taskType', async () => {
      await ClusterScheduleEntry.create([
        { source: 'n8n', sourceId: 'a', name: 'Bench', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } },
        { source: 'n8n', sourceId: 'b', name: 'Sync', taskType: 'sync', schedule: { type: 'cron', cron: '0 3 * * *' } }
      ]);
      const entries = await clusterScheduleService.getAllEntries({ taskType: 'benchmark' });
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('Bench');
    });

    it('filters by host', async () => {
      await ClusterScheduleEntry.create([
        { source: 'n8n', sourceId: 'a', name: 'H1', taskType: 'benchmark', host: 'primary', schedule: { type: 'cron', cron: '0 2 * * *' } },
        { source: 'n8n', sourceId: 'b', name: 'H2', taskType: 'benchmark', host: 'secondary', schedule: { type: 'cron', cron: '0 3 * * *' } }
      ]);
      const entries = await clusterScheduleService.getAllEntries({ host: 'primary' });
      expect(entries).toHaveLength(1);
      expect(entries[0].host).toBe('primary');
    });

    it('filters by source', async () => {
      await ClusterScheduleEntry.create([
        { source: 'n8n', sourceId: 'a', name: 'OC', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } },
        { source: 'agentx', sourceId: 'b', name: 'AX', taskType: 'sync', schedule: { type: 'interval', intervalMs: 5000 } }
      ]);
      const entries = await clusterScheduleService.getAllEntries({ source: 'agentx' });
      expect(entries).toHaveLength(1);
      expect(entries[0].source).toBe('agentx');
    });
  });

  // ── getTimeline ─────────────────────────────────────────────

  describe('getTimeline', () => {
    it('resolves cron entries into time slots', async () => {
      await ClusterScheduleEntry.create({
        source: 'n8n', sourceId: 'cron1', name: 'Hourly Task',
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
        source: 'n8n', sourceId: 'dis1', name: 'Disabled Task',
        taskType: 'benchmark', enabled: false,
        schedule: { type: 'cron', cron: '0 2 * * *' }
      });

      const timeline = await clusterScheduleService.getTimeline('2026-03-04', 'UTC');
      expect(timeline).toHaveLength(0);
    });
  });

  // ── getNextTasks ────────────────────────────────────────────

  describe('getNextTasks', () => {
    it('returns next occurrences sorted by time', async () => {
      await ClusterScheduleEntry.create([
        {
          source: 'n8n', sourceId: 'n1', name: 'Every 6h', taskType: 'sync', enabled: true,
          schedule: { type: 'cron', cron: '0 */6 * * *', timezone: 'UTC' }
        },
        {
          source: 'n8n', sourceId: 'n2', name: 'Every Hour', taskType: 'monitoring', enabled: true,
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
        { source: 'n8n', sourceId: 'l1', name: 'T1', taskType: 'sync', enabled: true, schedule: { type: 'cron', cron: '0 * * * *', timezone: 'UTC' } },
        { source: 'n8n', sourceId: 'l2', name: 'T2', taskType: 'sync', enabled: true, schedule: { type: 'cron', cron: '30 * * * *', timezone: 'UTC' } },
        { source: 'n8n', sourceId: 'l3', name: 'T3', taskType: 'sync', enabled: true, schedule: { type: 'cron', cron: '15 * * * *', timezone: 'UTC' } }
      ]);

      const tasks = await clusterScheduleService.getNextTasks(2);
      expect(tasks).toHaveLength(2);
    });

    it('excludes disabled entries', async () => {
      await ClusterScheduleEntry.create({
        source: 'n8n', sourceId: 'dis2', name: 'Off', taskType: 'benchmark', enabled: false,
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
        { source: 'n8n', sourceId: 'h1', name: 'Primary Task', taskType: 'benchmark', host: 'primary', enabled: true,
          schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }, estimatedDurationMs: 300000 },
        { source: 'n8n', sourceId: 'h2', name: 'Secondary Task', taskType: 'sync', host: 'secondary', enabled: true,
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

    it('includes VRAM capacity from host config', async () => {
      await ClusterScheduleEntry.create({
        source: 'n8n', sourceId: 'v1', name: 'T', taskType: 'benchmark', host: 'primary', enabled: true,
        schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }, estimatedDurationMs: 300000
      });

      const hosts = await clusterScheduleService.getTimelineByHost('2026-03-04', 'UTC');
      const primary = hosts.find(h => h.hostId === 'primary');
      expect(primary.vramCapacityMb).toBe(12288);
    });

    it('puts null-host tasks into unassigned', async () => {
      await ClusterScheduleEntry.create({
        source: 'n8n', sourceId: 'u1', name: 'No Host', taskType: 'monitoring', enabled: true,
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
    it('detects overlapping tasks on the same host', async () => {
      await ClusterScheduleEntry.create([
        { source: 'n8n', sourceId: 'c1', name: 'Task A', taskType: 'benchmark', host: 'primary', enabled: true,
          schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }, estimatedDurationMs: 7200000 },
        { source: 'n8n', sourceId: 'c2', name: 'Task B', taskType: 'sync', host: 'primary', enabled: true,
          schedule: { type: 'cron', cron: '0 3 * * *', timezone: 'UTC' }, estimatedDurationMs: 3600000 }
      ]);

      const conflicts = await clusterScheduleService.getConflicts('2026-03-04', 'UTC');
      expect(conflicts.length).toBeGreaterThanOrEqual(1);
      expect(conflicts[0].hostId).toBe('primary');
    });

    it('returns no conflicts for non-overlapping tasks', async () => {
      await ClusterScheduleEntry.create([
        { source: 'n8n', sourceId: 'nc1', name: 'Morning', taskType: 'benchmark', host: 'primary', enabled: true,
          schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }, estimatedDurationMs: 300000 },
        { source: 'n8n', sourceId: 'nc2', name: 'Afternoon', taskType: 'sync', host: 'primary', enabled: true,
          schedule: { type: 'cron', cron: '0 14 * * *', timezone: 'UTC' }, estimatedDurationMs: 300000 }
      ]);

      const conflicts = await clusterScheduleService.getConflicts('2026-03-04', 'UTC');
      expect(conflicts).toHaveLength(0);
    });

    it('ignores continuous tasks in conflict detection', async () => {
      await ClusterScheduleEntry.create([
        { source: 'ollama-persistent', sourceId: 'pc1', name: 'Resident Model', taskType: 'inference', host: 'primary', enabled: true,
          schedule: { type: 'continuous' } },
        { source: 'n8n', sourceId: 'pc2', name: 'Cron Task', taskType: 'benchmark', host: 'primary', enabled: true,
          schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'UTC' }, estimatedDurationMs: 300000 }
      ]);

      const conflicts = await clusterScheduleService.getConflicts('2026-03-04', 'UTC');
      expect(conflicts).toHaveLength(0);
    });
  });

  // ── syncEntries ─────────────────────────────────────────────

  describe('syncEntries', () => {
    it('creates new entries', async () => {
      const stats = await clusterScheduleService.syncEntries([
        { source: 'n8n', sourceId: 'new1', name: 'New Task', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } }
      ]);
      expect(stats.created).toBe(1);
      expect(stats.updated).toBe(0);
      expect(await ClusterScheduleEntry.countDocuments()).toBe(1);
    });

    it('updates existing entries when changed', async () => {
      await ClusterScheduleEntry.create({
        source: 'n8n', sourceId: 'upd1', name: 'Old Name', taskType: 'benchmark',
        schedule: { type: 'cron', cron: '0 2 * * *' }
      });

      const stats = await clusterScheduleService.syncEntries([
        { source: 'n8n', sourceId: 'upd1', name: 'New Name', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' } }
      ]);
      expect(stats.updated).toBe(1);
      expect(stats.created).toBe(0);

      const doc = await ClusterScheduleEntry.findOne({ sourceId: 'upd1' });
      expect(doc.name).toBe('New Name');
    });

    it('reports unchanged when no diff', async () => {
      await ClusterScheduleEntry.create({
        source: 'n8n', sourceId: 'same1', name: 'Same', taskType: 'benchmark',
        schedule: { type: 'cron', cron: '0 2 * * *' }, priority: 5, enabled: true
      });

      const stats = await clusterScheduleService.syncEntries([
        { source: 'n8n', sourceId: 'same1', name: 'Same', taskType: 'benchmark', schedule: { type: 'cron', cron: '0 2 * * *' }, priority: 5, enabled: true }
      ]);
      expect(stats.unchanged).toBe(1);
    });

    it('does not create duplicates on re-sync', async () => {
      const entries = [
        { source: 'n8n', sourceId: 'dup1', name: 'Dedup', taskType: 'sync', schedule: { type: 'cron', cron: '0 * * * *' } }
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
