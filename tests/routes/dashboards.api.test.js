/**
 * Integration Tests for Dashboard API Routes
 */

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const CustomDashboard = require('../../models/CustomDashboard');

const workspaceId = '507f191e810c19729de860ea';
const userId = '507f1f77bcf86cd799439011';
let mockIsAdmin = true;

jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { _id: '507f1f77bcf86cd799439011', userId: 'test-user-123' };
    res.locals.user = req.user;
    next();
  }
}));

jest.mock('../../src/middleware/workspace', () => ({
  attachWorkspace: (req, res, next) => {
    req.workspace = { _id: '507f191e810c19729de860ea', slug: 'test-workspace' };
    next();
  },
  requireWorkspaceAccess: (req, res, next) => {
    req.workspaceMember = {
      isAdmin: () => mockIsAdmin
    };
    next();
  },
  requireAdmin: (req, res, next) => {
    if (!mockIsAdmin) {
      return res.status(403).json({
        status: 'error',
        message: 'Administrator access required',
        code: 'ADMIN_REQUIRED'
      });
    }
    next();
  }
}));

const app = express();
app.use(express.json());

const dashboardRoutes = require('../../routes/dashboards');
app.use('/api/dashboards', dashboardRoutes);

const validWidget = {
  id: 'panel_1',
  title: 'Conversation Count',
  type: 'metric',
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  dataSource: {
    collection: 'conversations',
    aggregation: 'count'
  }
};

describe('Dashboard API Routes', () => {
  beforeEach(async () => {
    mockIsAdmin = true;
    await CustomDashboard.deleteMany({});
  });

  afterAll(async () => {
    await CustomDashboard.deleteMany({});
  });

  it('creates a new dashboard', async () => {
    const response = await request(app)
      .post('/api/dashboards')
      .send({
        name: 'My Dashboard',
        description: 'Test dashboard',
        layout: [validWidget]
      })
      .expect(201);

    expect(response.body.status).toBe('success');
    expect(response.body.data.name).toBe('My Dashboard');
    expect(response.body.data.layout).toHaveLength(1);
  });

  it('rejects dashboard creation for non-admin users', async () => {
    mockIsAdmin = false;
    const response = await request(app)
      .post('/api/dashboards')
      .send({
        name: 'My Dashboard',
        layout: [validWidget]
      })
      .expect(403);

    expect(response.body.status).toBe('error');
  });

  it('rejects invalid dashboard layout', async () => {
    const response = await request(app)
      .post('/api/dashboards')
      .send({
        name: 'Bad Dashboard',
        layout: [{ id: 'bad-panel', type: 'metric' }]
      })
      .expect(400);

    expect(response.body.status).toBe('error');
    expect(response.body.message).toContain('dataSource');
  });

  it('supports panel CRUD operations', async () => {
    const dashboard = await CustomDashboard.create({
      workspaceId,
      createdBy: userId,
      name: 'Panel Dashboard',
      layout: []
    });

    const addResponse = await request(app)
      .post(`/api/dashboards/${dashboard._id}/panels`)
      .send(validWidget)
      .expect(201);

    expect(addResponse.body.status).toBe('success');
    expect(addResponse.body.data.layout).toHaveLength(1);

    const panelId = addResponse.body.data.layout[0].id;

    const updateResponse = await request(app)
      .patch(`/api/dashboards/${dashboard._id}/panels/${panelId}`)
      .send({ title: 'Updated Panel' })
      .expect(200);

    expect(updateResponse.body.data.layout[0].title).toBe('Updated Panel');

    const deleteResponse = await request(app)
      .delete(`/api/dashboards/${dashboard._id}/panels/${panelId}`)
      .expect(200);

    expect(deleteResponse.body.status).toBe('success');
    expect(deleteResponse.body.data.layout).toHaveLength(0);
  });
});
