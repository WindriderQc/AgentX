'use strict';

const { projectSelfHealing } = require('../../src/services/selfHealingProjection');
const now = new Date('2026-10-01T12:00:00Z');
const at = '2026-10-01T11:00:00Z';
const wrap = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
const row = (data, id) => data.rows.find(item => item.id === id);
const event = (type, timestamp = at, extra = {}) => ({ type, timestamp, hostUrl: 'http://engine.test:11434', hostId: 'engine',
  origin: 'autonomous', operationId: 'synthetic-cycle', ...extra });

describe('observable automation projection', () => {
  test('disabled settings stay disabled, independent of historical evidence or loaded state', () => {
    const data = projectSelfHealing(wrap({
      pins: { rows: [{ hostKey: 'engine', hostUrl: 'http://engine.test:11434', status: 'ready', updatedAt: at,
        loadedModels: ['synthetic-pin'], pinnedModels: [{ model: 'synthetic-pin', autoRestore: false }] }] },
      pinDaemon: { running: true },
      rules: { rows: [{ ruleId: 'diagnostic', enabled: false, name: 'Diagnostic' }] }, engine: [],
      alerts: [{ _id: 'diagnostic', alert: { _id: 'alert-1', timestamp: at, status: 'resolved' } }],
      watchSettings: { enabled: false, source: 'saved' },
      watchdog: { isRunning: false, config: { reloadAfterUnjam: false }, history: [] }
    }), now);
    expect(row(data, 'pin:engine:0')).toMatchObject({ enabled: false, running: true, last: { timestamp: null, outcome: 'unknown' } });
    expect(row(data, 'rule:diagnostic')).toMatchObject({ enabled: false, running: false, mode: 'detection', last: { outcome: 'detected', reason: 'resolved' } });
    expect(row(data, 'ops-watch').enabled).toBe(false);
    expect(row(data, 'watchdog-reload').enabled).toBe(false);
  });

  test('retains fallback date, result and provenance without turning route configuration into execution', () => {
    const data = projectSelfHealing(wrap({ fallback: { _id: 'synthetic-log', timestamp: at, status: 'error', fallbackUsed: true, fallbackReason: 'host_unavailable' },
      ladders: { configuredTasks: ['synthetic-task'], configurationErrors: [] } }), now);
    expect(row(data, 'routing-fallbacks').last).toMatchObject({ timestamp: '2026-10-01T11:00:00.000Z', outcome: 'error',
      source: 'InferenceLog', id: 'synthetic-log', event: 'fallbackUsed', reason: 'host_unavailable', freshness: 'recent' });
    expect(row(data, 'task-fallbacks')).toMatchObject({ enabled: true, last: { outcome: 'unknown', timestamp: null } });
  });

  test('missing, unavailable, invalid and historical evidence never become current health', () => {
    const empty = projectSelfHealing({ watchdog: { unavailable: true }, pins: { unavailable: true } }, now);
    expect(empty.rows.every(item => item.last.outcome === 'unknown')).toBe(true);
    expect(empty.sources.watchdog.status).toBe('unavailable');
    expect(row(empty, 'watchdog-unjam')).toMatchObject({ enabled: null, running: null });
    const old = projectSelfHealing(wrap({ fallback: { timestamp: '2026-09-01T00:00:00Z', status: 'success' } }), now);
    expect(row(old, 'routing-fallbacks').last).toMatchObject({ outcome: 'success', freshness: 'historical' });
    const invalid = projectSelfHealing(wrap({ fallback: { timestamp: 'invalid', status: 'success' } }), now);
    expect(row(invalid, 'routing-fallbacks').last).toMatchObject({ outcome: 'unknown', freshness: 'not_observed' });
  });

  test('a completed unload is an action; detection and a restore trigger do not prove recovery', () => {
    const data = projectSelfHealing(wrap({ watchdog: { isRunning: true, config: { reloadAfterUnjam: true },
      hosts: [{ hostId: 'engine', lastProbeAt: at, lastResult: { ok: true, mode: 'control-plane' } }],
      history: [event('jam_detected'), event('unjam_success'), event('pin_restore_triggered')] } }), now);
    expect(row(data, 'watchdog-unjam')).toMatchObject({ mode: 'autonomous', last: { event: 'jam_detected', outcome: 'unload_completed' } });
    expect(row(data, 'watchdog-probes')).toMatchObject({ mode: 'detection', last: { outcome: 'unknown' } });
    expect(row(data, 'watchdog-reload').last).toMatchObject({ outcome: 'unknown', reason: 'pin_restore_triggered' });
  });

  test('manual reloads cannot supply an automatic result, even at the same millisecond', () => {
    const data = projectSelfHealing(wrap({ watchdog: { history: [event('jam_detected'), event('unjam_failed'),
      event('force_unjam', at, { origin: 'manual', operationId: 'manual-cycle' }),
      event('reload_success', at, { origin: 'manual', operationId: 'manual-cycle' })] } }), now);
    expect(row(data, 'watchdog-unjam').last.outcome).toBe('failed');
    expect(row(data, 'watchdog-reload').last.timestamp).toBeNull();
    const manual = projectSelfHealing(wrap({ watchdog: { history: [event('force_unjam'), event('reload_success')] } }), now);
    expect(row(manual, 'watchdog-unjam').last.timestamp).toBeNull();
    expect(row(manual, 'watchdog-reload').last.outcome).toBe('unknown');
  });

  test('uses delivery receipts, keeps external adapters unobserved and manual remedies linked', () => {
    const data = projectSelfHealing(wrap({ rules: { rows: [{ ruleId: 'diagnostic', enabled: true, channels: ['local_log'] }] },
      delivery: { _id: 'alert-1', ruleId: 'diagnostic', delivery: { local_log: { sent: false, sentAt: at } } },
      notifications: { email: { enabled: false, external: true } } }), now);
    expect(row(data, 'local-notification')).toMatchObject({ enabled: true, last: { outcome: 'failed', source: 'Alert.delivery.local_log' } });
    expect(row(data, 'notification:email')).toMatchObject({ enabled: false, last: { outcome: 'unknown' } });
    expect(data.manual).toHaveLength(3);
    expect(data.manual.every(item => item.operator.href)).toBe(true);
  });

  test('a late manual result cannot complete an overlapping automatic episode', () => {
    const data = projectSelfHealing(wrap({ watchdog: { history: [
      event('force_unjam', at, { origin: 'manual', operationId: 'manual-cycle' }),
      event('jam_detected'),
      event('reload_success', at, { origin: 'manual', operationId: 'manual-cycle' })
    ] } }), now);
    expect(row(data, 'watchdog-reload').last.outcome).toBe('unknown');
  });

  test('legacy chronological proximity without execution identity cannot prove automatic success', () => {
    const data = projectSelfHealing(wrap({ watchdog: { history: [
      event('jam_detected', at, { origin: undefined, operationId: undefined }),
      event('unjam_success', at, { origin: undefined, operationId: undefined }),
      event('reload_success', at, { origin: undefined, operationId: undefined })
    ] } }), now);
    expect(row(data, 'watchdog-unjam').last.outcome).toBe('unknown');
    expect(row(data, 'watchdog-reload').last.outcome).toBe('unknown');
  });

  test.each(['invalid', '2026-10-01T10:59:00Z', '2026-10-02T11:00:00Z'])(
    'a result dated %s cannot prove success for the retained trigger', resultAt => {
      const data = projectSelfHealing(wrap({ watchdog: { history: [event('jam_detected'),
        event('unjam_success', resultAt), event('reload_success', resultAt)] } }), now);
      expect(row(data, 'watchdog-unjam').last.outcome).toBe('unknown');
      expect(row(data, 'watchdog-reload').last.outcome).toBe('unknown');
    });

  test('an unclassified delivery and a malformed report stay unknown', () => {
    const data = projectSelfHealing(wrap({ delivery: { delivery: { local_log: { sentAt: at } } },
      watch: { latest: { at } } }), now);
    expect(row(data, 'local-notification').last.outcome).toBe('unknown');
    expect(row(data, 'ops-watch').last.outcome).toBe('unknown');
  });

  test('findings observed locally do not attest completed alert publication', () => {
    const data = projectSelfHealing(wrap({ watch: { latest: { at, findingCount: 2 } } }), now);
    expect(row(data, 'ops-watch').last.outcome).toBe('findings_observed');
  });

  test('local logging uses the owning channel fallback and incomplete enablement stays unknown', () => {
    const enabled = projectSelfHealing(wrap({ rules: { rows: [{ ruleId: 'local', enabled: true, channels: [] }] } }), now);
    expect(row(enabled, 'local-notification').enabled).toBe(true);
    const incomplete = projectSelfHealing(wrap({ rules: { rows: [{ ruleId: 'local', channels: [] }] } }), now);
    expect(row(incomplete, 'local-notification').enabled).toBeNull();
    expect(row(incomplete, 'rule:local').enabled).toBeNull();
  });
});
