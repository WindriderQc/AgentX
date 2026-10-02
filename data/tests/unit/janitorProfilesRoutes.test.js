const request = require('supertest');
const express = require('express');

jest.mock('../../services/janitorProfiles', () => ({
  list: jest.fn(),
  get: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn()
}));
jest.mock('../../services/janitorRunner', () => ({
  PROFILE_APPLY_CONFIRMATION: 'DELETE_APPROVED_FILES',
  RESTORE_SOURCE_CONFIRMATION: 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE',
  runProfile: jest.fn(),
  startProfileRun: jest.fn(),
  listRunsForProfile: jest.fn(),
  getRun: jest.fn(),
  approveAction: jest.fn(),
  rejectAction: jest.fn()
}));
jest.mock('../../services/janitorScheduler', () => ({
  reload: jest.fn(async () => {})
}));
jest.mock('../../services/janitorStrategy', () => ({
  getPolicy: jest.fn(),
  decisionsRequired: jest.fn(),
  savePolicy: jest.fn(),
  generateStrategy: jest.fn(),
  getLatestStrategy: jest.fn()
}));

const janitorProfiles = require('../../services/janitorProfiles');
const janitorRunner = require('../../services/janitorRunner');
const janitorScheduler = require('../../services/janitorScheduler');
const janitorStrategy = require('../../services/janitorStrategy');
const routes = require('../../routes/janitor-profiles.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.locals.db = {};
  app.use('/api/v1/janitor/profiles', routes);
  app.use((err, req, res, _next) => res.status(500).json({ status: 'error', message: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('shared-drive policy and strategy routes', () => {
  test('returns conservative policy and missing decisions', async () => {
    const policy = { duplicateSurvivor: null, maintenanceAuthorization: 'explicit_per_action' };
    const decisions = [{ field: 'duplicateSurvivor' }];
    janitorStrategy.getPolicy.mockResolvedValue(policy);
    janitorStrategy.decisionsRequired.mockReturnValue(decisions);

    const res = await request(buildApp()).get('/api/v1/janitor/profiles/shared-drive/policy');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ policy, decisions_required: decisions });
    expect(janitorProfiles.get).not.toHaveBeenCalled();
  });

  test('policy write requires confirmation and rejects invalid policy', async () => {
    const missing = await request(buildApp())
      .put('/api/v1/janitor/profiles/shared-drive/policy')
      .send({ policy: { duplicateSurvivor: 'newest' } });
    expect(missing.status).toBe(400);
    expect(janitorStrategy.savePolicy).not.toHaveBeenCalled();

    janitorStrategy.savePolicy.mockResolvedValue({
      ok: false,
      errors: ['duplicateSurvivor must be one of: canonical_active, newest, oldest']
    });
    const invalid = await request(buildApp())
      .put('/api/v1/janitor/profiles/shared-drive/policy')
      .send({ confirm: true, policy: { duplicateSurvivor: 'automatic' } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors[0]).toMatch(/duplicateSurvivor/);
  });

  test('confirmed policy write delegates the exact operator decision', async () => {
    janitorStrategy.savePolicy.mockResolvedValue({
      ok: true,
      policy: { duplicateSurvivor: 'canonical_active' },
      decisions_required: []
    });
    const res = await request(buildApp())
      .put('/api/v1/janitor/profiles/shared-drive/policy')
      .send({
        confirm: true,
        updated_by: 'example-operator',
        policy: { duplicateSurvivor: 'canonical_active' }
      });

    expect(res.status).toBe(200);
    expect(janitorStrategy.savePolicy).toHaveBeenCalledWith(
      expect.any(Object),
      { duplicateSurvivor: 'canonical_active' },
      { updatedBy: 'example-operator' }
    );
  });

  test('generates a persisted read-only strategy and returns latest report', async () => {
    const report = {
      _id: 'strategy-1',
      status: 'awaiting_policy',
      maintenance: { proposals: [], executableActions: [] }
    };
    janitorStrategy.generateStrategy.mockResolvedValue({ report });
    janitorStrategy.getLatestStrategy.mockResolvedValue(report);

    const generated = await request(buildApp())
      .post('/api/v1/janitor/profiles/shared-drive/strategy')
      .send({});
    const latest = await request(buildApp())
      .get('/api/v1/janitor/profiles/shared-drive/strategy/latest');

    expect(generated.status).toBe(201);
    expect(generated.body.data.report.status).toBe('awaiting_policy');
    expect(janitorStrategy.generateStrategy).toHaveBeenCalledWith(
      expect.any(Object), { persist: true }
    );
    expect(latest.status).toBe(200);
    expect(latest.body.data.report._id).toBe('strategy-1');
  });
});

describe('GET /', () => {
  test('returns list of profiles', async () => {
    janitorProfiles.list.mockResolvedValue([{ _id: 'a', name: 'A' }]);
    const res = await request(buildApp()).get('/api/v1/janitor/profiles');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.profiles).toHaveLength(1);
  });
});

describe('POST /', () => {
  test('creates a profile and triggers scheduler reload', async () => {
    janitorProfiles.create.mockResolvedValue({ ok: true, profile: { _id: 'new', name: 'X' } });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles').send({ name: 'X' });
    expect(res.status).toBe(201);
    expect(janitorScheduler.reload).toHaveBeenCalledWith(expect.any(Object), 'new');
  });

  test('returns 400 on validation failure', async () => {
    janitorProfiles.create.mockResolvedValue({ ok: false, errors: ['name required'] });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles').send({});
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['name required']);
  });

  test('returns 409 on conflict', async () => {
    janitorProfiles.create.mockResolvedValue({ ok: false, conflict: true, errors: ['name "X" already exists'] });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles').send({ name: 'X' });
    expect(res.status).toBe(409);
  });
});

describe('GET /:id', () => {
  test('returns the profile', async () => {
    janitorProfiles.get.mockResolvedValue({ _id: 'a', name: 'A' });
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/a');
    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe('A');
  });

  test('returns 404 when missing', async () => {
    janitorProfiles.get.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/nope');
    expect(res.status).toBe(404);
  });
});

describe('PUT /:id', () => {
  test('updates and reloads scheduler', async () => {
    janitorProfiles.update.mockResolvedValue({ ok: true, profile: { _id: 'a', name: 'A2' } });
    const res = await request(buildApp()).put('/api/v1/janitor/profiles/a').send({ name: 'A2' });
    expect(res.status).toBe(200);
    expect(janitorScheduler.reload).toHaveBeenCalledWith(expect.any(Object), 'a');
  });

  test('returns 404 when notFound', async () => {
    janitorProfiles.update.mockResolvedValue({ ok: false, notFound: true, errors: ['profile not found'] });
    const res = await request(buildApp()).put('/api/v1/janitor/profiles/x').send({});
    expect(res.status).toBe(404);
  });

  test('returns 400 on badRequest (invalid id)', async () => {
    janitorProfiles.update.mockResolvedValue({ ok: false, badRequest: true, errors: ['invalid id'] });
    const res = await request(buildApp()).put('/api/v1/janitor/profiles/bad-id').send({});
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['invalid id']);
  });
});

describe('DELETE /:id', () => {
  test('deletes and reloads scheduler', async () => {
    janitorProfiles.remove.mockResolvedValue({ ok: true });
    const res = await request(buildApp()).delete('/api/v1/janitor/profiles/a');
    expect(res.status).toBe(200);
    expect(janitorScheduler.reload).toHaveBeenCalledWith(expect.any(Object), 'a');
  });

  test('returns 404 when missing', async () => {
    janitorProfiles.remove.mockResolvedValue({ ok: false, notFound: true });
    const res = await request(buildApp()).delete('/api/v1/janitor/profiles/x');
    expect(res.status).toBe(404);
  });

  test('returns 400 on badRequest (invalid id)', async () => {
    janitorProfiles.remove.mockResolvedValue({ ok: false, badRequest: true, errors: ['invalid id'] });
    const res = await request(buildApp()).delete('/api/v1/janitor/profiles/bad-id');
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['invalid id']);
  });
});

describe('POST /:id/run', () => {
  test('triggers a run and returns the run id', async () => {
    janitorRunner.startProfileRun.mockResolvedValue({ ok: true, run_id: 'r1' });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/a/run');
    expect(res.status).toBe(202);
    expect(res.body.data.run_id).toBe('r1');
  });

  test('returns 409 when already running', async () => {
    janitorRunner.startProfileRun.mockResolvedValue({ ok: false, alreadyRunning: true });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/a/run');
    expect(res.status).toBe(409);
  });

  test('returns 404 when profile missing', async () => {
    janitorRunner.startProfileRun.mockResolvedValue({ ok: false, notFound: true });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/x/run');
    expect(res.status).toBe(404);
  });

  test('returns 500 on generic runner failure', async () => {
    janitorRunner.startProfileRun.mockResolvedValue({ ok: false, error: 'scan failed' });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/a/run');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('scan failed');
  });
});

describe('GET /:id/runs', () => {
  test('returns paginated runs', async () => {
    janitorRunner.listRunsForProfile.mockResolvedValue({ runs: [{ _id: 'r1' }], total: 1, page: 1, limit: 20 });
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/a/runs');
    expect(res.status).toBe(200);
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.pagination.total).toBe(1);
  });
});

describe('GET /runs/:run_id', () => {
  test('returns run detail', async () => {
    janitorRunner.getRun.mockResolvedValue({ _id: 'r1', proposed_actions: [] });
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/runs/r1');
    expect(res.status).toBe(200);
    expect(res.body.data.run._id).toBe('r1');
  });

  test('returns 404 when missing', async () => {
    janitorRunner.getRun.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/runs/nope');
    expect(res.status).toBe(404);
  });
});

describe('POST /runs/:run_id/actions/:idx/approve', () => {
  test('approves and returns the action', async () => {
    janitorRunner.approveAction.mockResolvedValue({
      ok: true,
      action: { policy: 'delete_duplicates', status: 'executed' },
      result: { deleted: [{}], failed: [], space_freed: 100 }
    });
    const res = await request(buildApp())
      .post('/api/v1/janitor/profiles/runs/r1/actions/0/approve')
      .send({
        confirm: true,
        dry_run: false,
        preview_id: 'preview-1',
        apply_confirm: 'DELETE_APPROVED_FILES',
        restore_confirm: 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE'
      });
    expect(res.status).toBe(200);
    expect(res.body.data.action.status).toBe('executed');
    expect(janitorRunner.approveAction).toHaveBeenCalledWith(
      expect.any(Object), 'r1', 0, {
        confirm: true,
        dryRun: false,
        keepPath: undefined,
        previewId: 'preview-1',
        applyConfirmation: 'DELETE_APPROVED_FILES',
        restoreConfirmation: 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE'
      }
    );
  });

  test('returns 409 when action is not pending', async () => {
    janitorRunner.approveAction.mockResolvedValue({ ok: false, error: 'action is executed' });
    const res = await request(buildApp())
      .post('/api/v1/janitor/profiles/runs/r1/actions/0/approve')
      .send({
        confirm: true,
        dry_run: false,
        preview_id: 'preview-1',
        apply_confirm: 'DELETE_APPROVED_FILES',
        restore_confirm: 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE'
      });
    expect(res.status).toBe(409);
  });

  test('returns 404 when run/action missing', async () => {
    janitorRunner.approveAction.mockResolvedValue({ ok: false, notFound: true });
    const res = await request(buildApp())
      .post('/api/v1/janitor/profiles/runs/r1/actions/9/approve')
      .send({
        confirm: true,
        dry_run: false,
        preview_id: 'preview-1',
        apply_confirm: 'DELETE_APPROVED_FILES',
        restore_confirm: 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE'
      });
    expect(res.status).toBe(404);
  });

  test('requires explicit confirmation and defaults approved calls to dry-run preview', async () => {
    const missing = await request(buildApp())
      .post('/api/v1/janitor/profiles/runs/r1/actions/0/approve')
      .send({});
    expect(missing.status).toBe(400);

    janitorRunner.approveAction.mockResolvedValue({
      ok: true,
      preview: true,
      action: { status: 'pending' },
      result: { dry_run: true, deleted: [{ action: 'would_delete' }] }
    });
    const preview = await request(buildApp())
      .post('/api/v1/janitor/profiles/runs/r1/actions/0/approve')
      .send({ confirm: true });
    expect(preview.status).toBe(200);
    expect(preview.body.data.preview).toBe(true);
    expect(janitorRunner.approveAction).toHaveBeenCalledWith(
      expect.any(Object), 'r1', 0, {
        confirm: true,
        dryRun: true,
        keepPath: undefined,
        previewId: undefined,
        applyConfirmation: undefined,
        restoreConfirmation: undefined
      }
    );
  });

  test('rejects a direct live request without an exact preview id and confirmation phrase', async () => {
    const res = await request(buildApp())
      .post('/api/v1/janitor/profiles/runs/r1/actions/0/approve')
      .send({ confirm: true, dry_run: false });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/preview_id.*apply_confirm.*restore_confirm/i);
    expect(janitorRunner.approveAction).not.toHaveBeenCalled();
  });

  test('passes an explicit survivor choice only to the dry-run preview', async () => {
    janitorRunner.approveAction.mockResolvedValue({
      ok: true,
      preview: true,
      action: { status: 'pending', keep: { path: '/mnt/datalake/b.txt' } },
      result: { dry_run: true }
    });
    const res = await request(buildApp())
      .post('/api/v1/janitor/profiles/runs/r1/actions/0/approve')
      .send({ confirm: true, dry_run: true, keep_path: '/mnt/datalake/b.txt' });

    expect(res.status).toBe(200);
    expect(janitorRunner.approveAction).toHaveBeenCalledWith(
      expect.any(Object), 'r1', 0, expect.objectContaining({
        dryRun: true,
        keepPath: '/mnt/datalake/b.txt'
      })
    );
  });

  test('reports uncommissioned live maintenance as unavailable', async () => {
    janitorRunner.approveAction.mockResolvedValue({
      ok: false,
      notCommissioned: true,
      error: 'live janitor maintenance is not commissioned'
    });
    const res = await request(buildApp())
      .post('/api/v1/janitor/profiles/runs/r1/actions/0/approve')
      .send({
        confirm: true,
        dry_run: false,
        preview_id: 'preview-1',
        apply_confirm: 'DELETE_APPROVED_FILES',
        restore_confirm: 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE'
      });

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/not commissioned/i);
  });
});

describe('POST /runs/:run_id/actions/:idx/reject', () => {
  test('rejects and returns the action', async () => {
    janitorRunner.rejectAction.mockResolvedValue({ ok: true, action: { status: 'rejected' } });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/0/reject');
    expect(res.status).toBe(200);
    expect(res.body.data.action.status).toBe('rejected');
  });

  test('returns 404 when run/action missing', async () => {
    janitorRunner.rejectAction.mockResolvedValue({ ok: false, notFound: true });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/0/reject');
    expect(res.status).toBe(404);
  });

  test('returns 409 when action is not pending', async () => {
    janitorRunner.rejectAction.mockResolvedValue({ ok: false, error: 'action is rejected' });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/0/reject');
    expect(res.status).toBe(409);
  });
});
