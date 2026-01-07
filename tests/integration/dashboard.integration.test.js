const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const { app } = require('../../src/app');
const User = require('../../models/UserProfile');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');
const CustomDashboard = require('../../models/CustomDashboard');

describe('CustomDashboard Model Tests', () => {
    let mongod;
    let workspace;
    let user;

    beforeAll(async () => {
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }
        mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());
        
        user = await User.create({ name: 'dashOwner', userId: 'user1', email: 'dash@example.com', password: 'pw' });
        workspace = await Workspace.create({ 
            name: 'DashWS', slug: 'dash-ws', ownerId: user._id 
        });
    });

    afterAll(async () => {
        await mongoose.disconnect();
        await mongod.stop();
    });

    it('should create a dashboard attached to workspace', async () => {
        const dash = await CustomDashboard.create({
            workspaceId: workspace._id,
            createdBy: user._id,
            name: 'My Dashboard',
            layout: []
        });
        
        expect(dash.workspaceId.toString()).toBe(workspace._id.toString());
        expect(dash.name).toBe('My Dashboard');
    });

    it('should store layout configurations', async () => {
        const layout = [{
            id: 'w1', x: 0, y: 0, w: 2, h: 2,
            type: 'chart',
            title: 'Conversations per Day',
            dataSource: { collection: 'conversations', groupBy: 'createdAt' },
            chartType: 'line'
        }];

        const dash = await CustomDashboard.create({
            workspaceId: workspace._id,
            createdBy: user._id,
            name: 'Analytics Board',
            layout
        });

        expect(dash.layout).toHaveLength(1);
        expect(dash.layout[0].type).toBe('chart');
        expect(dash.layout[0].dataSource.collection).toBe('conversations');
    });

    it('should enforce required fields', async () => {
        await expect(CustomDashboard.create({
            // Missing workspaceId
            createdBy: user._id,
            name: 'Bad Dash'
        })).rejects.toThrow();
    });
});
