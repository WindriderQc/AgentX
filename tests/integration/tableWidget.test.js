const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const CustomDashboard = require('../../models/CustomDashboard');
const Alert = require('../../models/Alert');
const User = require('../../models/UserProfile');
const Workspace = require('../../models/Workspace');

describe('Table Widget Integration', () => {
    let mongod;
    let workspace;
    let user;

    beforeAll(async () => {
        // Ensure no previous connections
        await mongoose.disconnect();
        
        mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());
        
        user = await User.create({ name: 'TableUser', userId: 'tableu', email: 'table@example.com' });
        workspace = await Workspace.create({ name: 'TableWS', slug: 'table-ws', ownerId: user._id });
    });

    afterAll(async () => {
        await mongoose.disconnect();
        if (mongod) await mongod.stop();
    });

    it('should allow creating a dashboard with a TABLE widget and PIPELINE', async () => {
        const layout = [{
            id: 't1', x: 0, y: 0, w: 4, h: 3,
            type: 'table',
            title: 'Active Alerts',
            dataSource: { 
                collection: 'alerts', // Using alerts as they have status
                pipeline: [
                    { $match: { status: 'active' } },
                    { $project: { title: 1, severity: 1, createdAt: 1 } }
                ]
            }
        }];

        const dash = await CustomDashboard.create({
            workspaceId: workspace._id,
            createdBy: user._id,
            name: 'Table Dash',
            layout
        });

        expect(dash.layout[0].type).toBe('table');
        expect(dash.layout[0].dataSource.pipeline).toBeDefined();
        // Since pipeline is mixed/array, it should persist
        expect(dash.layout[0].dataSource.pipeline).toHaveLength(2);
        expect(dash.layout[0].dataSource.pipeline[0].$match.status).toBe('active');
    });

    it('should validate aggregate pipeline execution on seeded data', async () => {
         // Create dummy alerts
         await Alert.create([
             { workspaceId: workspace._id, title: 'High CPU', message: 'CPU > 90%', severity: 'critical', status: 'active', fingerprint: 'cpu-high' },
             { workspaceId: workspace._id, title: 'Low Memory', message: 'RAM < 10%', severity: 'warning', status: 'active', fingerprint: 'mem-low' },
             { workspaceId: workspace._id, title: 'Backup Success', message: 'Done', severity: 'info', status: 'resolved', fingerprint: 'backup-ok' }
         ]);

         // Simulate the pipeline logic used in dash
         // The route appends workspaceId match to the front
         
         const pipeline = [
             { $match: { workspaceId: workspace._id } },
             { $match: { status: 'active' } },
             { $group: { _id: '$severity', count: { $sum: 1 } } },
             { $sort: { _id: 1 } }
         ];

         const results = await Alert.aggregate(pipeline);
         
         // expect critial(1) and warning(1)
         expect(results).toHaveLength(2);
         expect(results.find(r => r._id === 'critical').count).toBe(1);
         expect(results.find(r => r._id === 'warning').count).toBe(1);
    });
});
