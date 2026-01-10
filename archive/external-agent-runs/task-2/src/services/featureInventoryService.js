const fs = require('fs/promises');
const path = require('path');

class FeatureInventoryService {
    constructor(rootPath) {
        this.rootPath = rootPath;
        this.inventory = {
            frontend: [],
            backend: [],
            documentation: []
        };
        this.alignmentReport = null;
    }

    // Helper: Recursively walk directory and apply callback to files
    async _walk(dir, fileCallback) {
        let files;
        try {
            files = await fs.readdir(dir);
        } catch (e) {
            // Directory might not exist, just return
            return;
        }

        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = await fs.stat(filePath);

            if (stat.isDirectory()) {
                await this._walk(filePath, fileCallback);
            } else {
                await fileCallback(filePath, file);
            }
        }
    }

    async scanFrontend() {
        const publicDir = path.join(this.rootPath, 'public');
        
        await this._walk(publicDir, async (filePath, fileName) => {
            if (fileName.endsWith('.html')) {
                const content = await fs.readFile(filePath, 'utf-8');
                
                // Feature by filename (primary)
                // e.g., 'dashboard.html' -> 'dashboard'
                let featureName = path.basename(fileName, '.html').replace(/-/g, ' ');
                featureName = featureName.charAt(0).toUpperCase() + featureName.slice(1);

                // Feature by title (secondary)
                const titleMatch = content.match(/<title>(.*?)<\/title>/);
                const title = titleMatch ? titleMatch[1].trim() : null;

                this.inventory.frontend.push({
                    id: path.basename(fileName, '.html'),
                    name: title || featureName,
                    source: path.relative(this.rootPath, filePath),
                    type: 'html'
                });
            } else if (fileName.endsWith('.js')) {
                // Heuristic: Scan for class definitions or specific comments
                // e.g. "class DashboardController" -> "dashboard"
                const content = await fs.readFile(filePath, 'utf-8');
                const classMatch = content.match(/class\s+([A-Z][a-zA-Z0-9]+)Controller/);
                
                if (classMatch) {
                    const featureName = classMatch[1]; // "Dashboard"
                    this.inventory.frontend.push({
                        id: featureName.toLowerCase(),
                        name: featureName,
                        source: path.relative(this.rootPath, filePath),
                        type: 'js_controller'
                    });
                }
            }
        });
        
        return this.inventory.frontend;
    }

    async scanBackend() {
        const routesDir = path.join(this.rootPath, 'routes');
        const servicesDir = path.join(this.rootPath, 'src', 'services');

        // Scan Routes
        await this._walk(routesDir, async (filePath, fileName) => {
            if (fileName.endsWith('.js')) {
                const content = await fs.readFile(filePath, 'utf-8');
                
                // Pattern: router.get('/path'
                const routeMatches = [...content.matchAll(/router\.(get|post|put|delete)\(['"]\/([^'"]*)['"]/g)];
                
                // Group by file, usually a route file corresponds to a feature set
                // e.g. 'authRoutes.js' -> 'auth'
                const fileFeatureId = fileName.replace(/(Routes|Route|_routes|_route)\.js$/i, '').toLowerCase();

                // If specific routes found, note them
                const endpoints = routeMatches.map(m => m[2].split('/')[0]).filter(Boolean);
                const uniqueEndpoints = [...new Set(endpoints)];

                if (uniqueEndpoints.length > 0) {
                     this.inventory.backend.push({
                        id: fileFeatureId, // Primary lookup ID
                        name: fileFeatureId.charAt(0).toUpperCase() + fileFeatureId.slice(1),
                        source: path.relative(this.rootPath, filePath),
                        endpoints: uniqueEndpoints,
                        type: 'route'
                    });
                } else {
                    // Fallback using filename if no explicit routes found by regex (e.g. specialized router structure)
                    this.inventory.backend.push({
                        id: fileFeatureId,
                        name: fileFeatureId.charAt(0).toUpperCase() + fileFeatureId.slice(1),
                        source: path.relative(this.rootPath, filePath),
                        type: 'route_file_inferred'
                    });
                }
            }
        });

        // Scan Services
        await this._walk(servicesDir, async (filePath, fileName) => {
            if (fileName.endsWith('Service.js')) {
                const featureId = fileName.replace('Service.js', '').toLowerCase();
                this.inventory.backend.push({
                    id: featureId,
                    name: featureId.charAt(0).toUpperCase() + featureId.slice(1),
                    source: path.relative(this.rootPath, filePath),
                    type: 'service'
                });
            }
        });

        return this.inventory.backend;
    }

    async scanDocumentation() {
        const docsDir = path.join(this.rootPath, 'docs');
        const rootDir = this.rootPath;

        const scanMdFile = async (filePath, fileName) => {
             if (fileName.endsWith('.md')) {
                const content = await fs.readFile(filePath, 'utf-8');
                
                // ID from filename: 'DEPLOYMENT.md' -> 'deployment'
                const featureId = path.basename(fileName, '.md').toLowerCase();
                
                // Name from H1
                const titleMatch = content.match(/^#\s+(.+)$/m);
                const title = titleMatch ? titleMatch[1].trim() : featureId;
                
                this.inventory.documentation.push({
                    id: featureId,
                    name: title,
                    source: path.relative(this.rootPath, filePath),
                    type: 'markdown'
                });
            }
        };

        // Scan docs folder
        await this._walk(docsDir, scanMdFile);

        // Scan root MD files (explicitly requested in prompt as "docs md", often they are in root)
        const rootFiles = await fs.readdir(rootDir);
        for(const file of rootFiles) {
            if(file.endsWith('.md')) {
                await scanMdFile(path.join(rootDir, file), file);
            }
        }

        return this.inventory.documentation;
    }

    matchFeatures() {
        // Collect all unique IDs
        const allIds = new Set([
            ...this.inventory.frontend.map(i => i.id),
            ...this.inventory.backend.map(i => i.id),
            ...this.inventory.documentation.map(i => i.id)
        ]);

        const features = [];

        for (const id of allIds) {
            const fe = this.inventory.frontend.find(i => i.id === id);
            const be = this.inventory.backend.find(i => i.id === id); // Could be multiple, simple find for now
            const doc = this.inventory.documentation.find(i => i.id === id);

            let score = 0;
            if (fe) score += 0.33;
            if (be) score += 0.33;
            if (doc) score += 0.33;
            // Round matching 0.99 to 1.0
            if (score > 0.9) score = 1.0;

            let status = 'Orphaned';
            if (fe && be && doc) status = 'Perfect Match';
            else if ((fe && be) || (be && doc) || (fe && doc)) status = 'Partial Match';

            features.push({
                id,
                name: fe?.name || be?.name || doc?.name || id,
                score: parseFloat(score.toFixed(2)),
                status,
                components: {
                    frontend: fe ? fe.source : null,
                    backend: be ? be.source : null,
                    documentation: doc ? doc.source : null
                }
            });
        }
        
        this.alignmentReport = features;
        return features;
    }

    async generateAlignmentReport() {
        await this.scanFrontend();
        await this.scanBackend();
        await this.scanDocumentation();
        return this.matchFeatures();
    }
}

module.exports = FeatureInventoryService;
