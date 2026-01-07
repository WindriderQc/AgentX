const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const FeatureInventory = require('../models/FeatureInventory');
const ApiTelemetry = require('../models/ApiTelemetry');
const FeatureUsage = require('../models/FeatureUsage');
const FeatureFlag = require('../models/FeatureFlag');

// Note: If mongodb-memory-server isn't available in the environment,
// these tests might fail if run directly without mocking.
// For schema validation, we don't strictly need a DB connection.
// But for uniqueness constraints and indexes, we do.
// I will structure this to use 'validateSync' for schema rules which is synchronous and offline.
// For helper methods, I will mock the internal calls or stub them if needed.

describe('Schema Validation Tests', () => {
  
  // FeatureInventory Validation
  describe('FeatureInventory Schema', () => {
    it('should be invalid if required fields are missing', () => {
      const doc = new FeatureInventory({});
      const err = doc.validateSync();
      expect(err.errors.name).toBeDefined();
      expect(err.errors.category).toBeDefined();
      expect(err.errors.status).toBeDefined();
    });

    it('should validate category enum', () => {
      const doc = new FeatureInventory({
        name: 'Test',
        category: 'invalid_category',
        status: 'complete'
      });
      const err = doc.validateSync();
      expect(err.errors.category).toBeDefined();
    });

    it('should calculate alignment score correctly', () => {
      const doc = new FeatureInventory({
        name: 'Test Feature',
        category: 'core',
        status: 'complete',
        frontend: { exists: true }, // +33.33
        backend: { exists: true },  // +33.33
        documentation: { exists: true, completeness: 50 } // +16.67
      });
      
      // 33.33 + 33.33 + 16.67 = 83.33 -> 83
      expect(doc.calculateAlignmentScore()).toBe(83);
    });
    
    it('should calculate perfect alignment score', () => {
        const doc = new FeatureInventory({
          name: 'Perfect Feature',
          category: 'core',
          status: 'complete',
          frontend: { exists: true },
          backend: { exists: true },
          documentation: { exists: true, completeness: 100 }
        });
        
        expect(doc.calculateAlignmentScore()).toBe(100);
      });
  });

  // ApiTelemetry Validation
  describe('ApiTelemetry Schema', () => {
    it('should default period to hourly', () => {
      const doc = new ApiTelemetry({
        endpoint: '/api/test',
        method: 'GET'
      });
      expect(doc.period).toBe('hourly');
    });

    it('should require endpoint and method', () => {
      const doc = new ApiTelemetry({});
      const err = doc.validateSync();
      expect(err.errors.endpoint).toBeDefined();
      expect(err.errors.method).toBeDefined();
    });
  });

  // FeatureUsage Validation
  describe('FeatureUsage Schema', () => {
    it('should validate action enum', () => {
      const doc = new FeatureUsage({
        feature: 'Test',
        action: 'invalid_action'
      });
      const err = doc.validateSync();
      expect(err.errors.action).toBeDefined();
    });

    it('should accept valid action', () => {
      const doc = new FeatureUsage({
        feature: 'Test',
        action: 'clicked'
      });
      const err = doc.validateSync();
      expect(err).toBeUndefined();
    });
  });

  // FeatureFlag Validation
  describe('FeatureFlag Schema', () => {
    it('should default rollout to 100', () => {
      const doc = new FeatureFlag({
        name: 'NewFlag',
        description: 'Test flag'
      });
      expect(doc.config.rolloutPercentage).toBe(100);
    });

    it('checkRollout should be deterministic', () => {
      const doc = new FeatureFlag({
        name: 'TestFlag',
        description: 'Testing',
        config: { rolloutPercentage: 50 },
        enabled: true
      });

      // Same user ID should always yield same result
      const userId = '507f1f77bcf86cd799439011';
      const result1 = doc.checkRollout(userId);
      const result2 = doc.checkRollout(userId);
      
      expect(result1).toBe(result2);
    });

    it('checkRollout should respect 0% and 100%', () => {
      const doc0 = new FeatureFlag({
        name: 'ZeroFlag',
        description: '0%',
        config: { rolloutPercentage: 0 }
      });
      expect(doc0.checkRollout('user1')).toBe(false);

      const doc100 = new FeatureFlag({
        name: 'FullFlag',
        description: '100%',
        config: { rolloutPercentage: 100 }
      });
      expect(doc100.checkRollout('user1')).toBe(true);
    });
  });

});
