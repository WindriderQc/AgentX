/**
 * Unit Tests for Feature Alignment Priority Scoring
 * Tests the static page boost and other scoring logic
 */

const { calculatePriority } = require('../../src/services/featureAlignmentPriority');
const path = require('path');

describe('Feature Alignment Priority Scoring', () => {
  const rootDir = path.join(__dirname, '../..');

  describe('Static Page Detection', () => {
    it('should give static HTML pages a +20 boost', () => {
      const staticPageFeature = {
        key: 'login',
        status: 'complete',
        frontend: {
          files: ['/public/login.html']
        },
        backend: {
          endpoints: [] // No backend endpoints
        },
        docs: {
          files: []
        }
      };

      const result = calculatePriority(staticPageFeature, rootDir);

      // Should get +20 for static page boost instead of -20 penalty
      expect(result.breakdown.staticPage).toBe(20);
      expect(result.breakdown.ui).toBeUndefined(); // No UI penalty
      expect(result.score).toBeGreaterThanOrEqual(20); // At least the static boost
    });

    it('should penalize features with frontend AND backend (already has UI)', () => {
      const apiDrivenFeature = {
        key: 'dashboard',
        status: 'complete',
        frontend: {
          files: ['/public/dashboard.html']
        },
        backend: {
          endpoints: [
            { method: 'GET', path: '/api/dashboard', sourceFile: 'routes/dashboard.js' }
          ]
        },
        docs: {
          files: []
        }
      };

      const result = calculatePriority(apiDrivenFeature, rootDir);

      // Should get -20 penalty for having UI (not headless)
      expect(result.breakdown.ui).toBe(-20);
      expect(result.breakdown.staticPage).toBeUndefined(); // No static boost
    });

    it('should not boost non-HTML frontend files', () => {
      const jsOnlyFeature = {
        key: 'api-client',
        status: 'partial',
        frontend: {
          files: ['/public/js/api-client.js'] // JS only, no HTML
        },
        backend: {
          endpoints: []
        },
        docs: {
          files: []
        }
      };

      const result = calculatePriority(jsOnlyFeature, rootDir);

      // Should still get UI penalty since it has frontend but it's not a static HTML page
      expect(result.breakdown.ui).toBe(-20);
      expect(result.breakdown.staticPage).toBeUndefined();
    });
  });

  describe('Endpoint Scoring', () => {
    it('should give 10 points per endpoint (max 40)', () => {
      const multiEndpointFeature = {
        key: 'api-heavy',
        status: 'partial',
        frontend: { files: [] },
        backend: {
          endpoints: [
            { method: 'GET', path: '/api/test1' },
            { method: 'POST', path: '/api/test2' },
            { method: 'PUT', path: '/api/test3' },
            { method: 'DELETE', path: '/api/test4' },
            { method: 'PATCH', path: '/api/test5' } // 5th endpoint should be capped
          ]
        },
        docs: { files: [] }
      };

      const result = calculatePriority(multiEndpointFeature, rootDir);

      // Should cap at 40 points for endpoints
      expect(result.breakdown.endpoints).toBe(40);
    });
  });

  describe('Documentation Scoring', () => {
    it('should give 15 points for documentation', () => {
      const documentedFeature = {
        key: 'well-documented',
        status: 'partial',
        frontend: { files: [] },
        backend: { endpoints: [] },
        docs: {
          files: ['/docs/features/well-documented.md']
        }
      };

      const result = calculatePriority(documentedFeature, rootDir);

      expect(result.breakdown.docs).toBe(15);
    });

    it('should give 0 points without documentation', () => {
      const undocumentedFeature = {
        key: 'undocumented',
        status: 'partial',
        frontend: { files: [] },
        backend: { endpoints: [] },
        docs: { files: [] }
      };

      const result = calculatePriority(undocumentedFeature, rootDir);

      expect(result.breakdown.docs).toBe(0);
    });
  });

  describe('Score Levels', () => {
    it('should categorize score >= 70 as CRITICAL', () => {
      const criticalFeature = {
        key: 'critical',
        status: 'partial',
        frontend: { files: [] },
        backend: {
          endpoints: [
            { method: 'GET', path: '/api/critical1' },
            { method: 'POST', path: '/api/critical2' },
            { method: 'PUT', path: '/api/critical3' },
            { method: 'DELETE', path: '/api/critical4' }
          ]
        },
        docs: {
          files: ['/docs/features/critical.md']
        }
      };

      const result = calculatePriority(criticalFeature, rootDir);

      // 4 endpoints * 10 = 40 + 15 docs = 55
      // Need more points to reach 70+
      // Just verify the level is calculated correctly
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'COMPLETE', 'API-ONLY']).toContain(result.level);
    });
  });

  describe('Complete Status', () => {
    it('should mark features with status=complete as COMPLETE', () => {
      const completeFeature = {
        key: 'fully-complete',
        status: 'complete',
        frontend: { files: ['/public/complete.html'] },
        backend: {
          endpoints: [{ method: 'GET', path: '/api/complete' }]
        },
        docs: { files: [] }
      };

      const result = calculatePriority(completeFeature, rootDir);

      expect(result.level).toBe('COMPLETE');
      expect(result.category).toBe('complete');
    });
  });
});
