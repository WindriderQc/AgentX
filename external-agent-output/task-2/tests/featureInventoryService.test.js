const FeatureInventoryService = require('../src/services/featureInventoryService');
const fs = require('fs/promises');
const path = require('path');

jest.mock('fs/promises');

describe('FeatureInventoryService', () => {
    let service;
    const mockRoot = '/mock/root';

    beforeEach(() => {
        service = new FeatureInventoryService(mockRoot);
        jest.clearAllMocks();
    });

    describe('scanFrontend', () => {
        it('should detect html files and extract titles', async () => {
            fs.readdir.mockImplementation(async (dir) => {
                if (dir.endsWith('public')) return ['dashboard.html', 'styles.css'];
                return [];
            });
            fs.stat.mockImplementation(async (filePath) => {
                return { isDirectory: () => false };
            });
            fs.readFile.mockImplementation(async (filePath) => {
                if (filePath.endsWith('dashboard.html')) return '<html><head><title>User Dashboard</title></head><body></body></html>';
                return '';
            });

            const result = await service.scanFrontend();
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                id: 'dashboard',
                name: 'User Dashboard',
                source: expect.stringContaining('public/dashboard.html'),
                type: 'html'
            });
        });
    });

    describe('scanBackend', () => {
        it('should detect route files and services', async () => {
            fs.readdir.mockImplementation(async (dir) => {
                if (dir.endsWith('routes')) return ['authRoutes.js'];
                if (dir.endsWith('services')) return ['AuthService.js'];
                return [];
            });
            fs.stat.mockImplementation(async (filePath) => {
                 return { isDirectory: () => false };
            });
            fs.readFile.mockImplementation(async (filePath) => {
                if (filePath.endsWith('authRoutes.js')) return "router.post('/login', ...); router.get('/logout', ...)";
                return '';
            });

            const result = await service.scanBackend();
            // Expecting 1 route file and 1 service file
            expect(result).toHaveLength(2);
            expect(result.find(r => r.type === 'route')).toBeDefined();
            expect(result.find(r => r.type === 'service')).toBeDefined();
            expect(result.find(r => r.id === 'auth')).toBeDefined();
        });
    });

    describe('scanDocumentation', () => {
        it('should detect markdown files in docs and root', async () => {
            fs.readdir.mockImplementation(async (dir) => {
                if (dir === mockRoot) return ['README.md', 'CONTRIBUTING.md'];
                if (dir.endsWith('docs')) return ['API.md'];
                return [];
            });
            fs.stat.mockImplementation(async (filePath) => {
                return { isDirectory: () => false };
            });
            fs.readFile.mockImplementation(async (filePath) => {
                if (filePath.endsWith('API.md')) return '# API Documentation';
                return '# Generic Title';
            });

            const result = await service.scanDocumentation();
            expect(result).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'api', name: 'API Documentation' }),
                expect.objectContaining({ id: 'readme' }),
                expect.objectContaining({ id: 'contributing' })
            ]));
        });
    });

    describe('matchFeatures', () => {
        it('should correctly classify Perfect Match', () => {
            service.inventory.frontend = [{ id: 'auth', name: 'Auth', source: 'public/auth.html' }];
            service.inventory.backend = [{ id: 'auth', name: 'Auth Service', source: 'src/services/AuthService.js' }];
            service.inventory.documentation = [{ id: 'auth', name: 'Auth Docs', source: 'docs/AUTH.md' }];

            const features = service.matchFeatures();
            expect(features).toHaveLength(1);
            expect(features[0].status).toBe('Perfect Match');
            expect(features[0].score).toBe(1.0);
        });

        it('should correctly classify Partial Match', () => {
            service.inventory.frontend = [{ id: 'dashboard', name: 'Dashboard' }];
            service.inventory.backend = [{ id: 'dashboard', name: 'Dashboard Routes' }];
            // Missing docs

            const features = service.matchFeatures();
            expect(features[0].status).toBe('Partial Match');
            expect(features[0].score).toBeLessThan(1.0);
        });

        it('should correctly classify Orphaned', () => {
             service.inventory.documentation = [{ id: 'legacy', name: 'Legacy Feature' }];
             
             const features = service.matchFeatures();
             expect(features[0].status).toBe('Orphaned');
             expect(features[0].score).toBeLessThan(0.4);
        });
    });
});
