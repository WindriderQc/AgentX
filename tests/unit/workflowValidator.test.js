/**
 * Unit Tests for Workflow Validator
 */

const validator = require('../../src/utils/workflowValidator');

describe('Workflow Validator', () => {
  describe('validateWorkflowStructure', () => {
    it('should validate a complete workflow structure', () => {
      const workflow = {
        name: 'Test Workflow',
        nodes: [],
        connections: {},
        settings: {}
      };

      const result = validator.validateWorkflowStructure(workflow);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const workflow = {
        name: 'Test Workflow'
        // Missing nodes and connections
      };

      const result = validator.validateWorkflowStructure(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: nodes');
      expect(result.errors).toContain('Missing required field: connections');
    });

    it('should reject invalid workflow object', () => {
      const result = validator.validateWorkflowStructure(null);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Workflow must be a valid object');
    });

    it('should reject empty workflow name', () => {
      const workflow = {
        name: '   ',
        nodes: [],
        connections: {}
      };

      const result = validator.validateWorkflowStructure(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Workflow name cannot be empty');
    });

    it('should warn about missing settings', () => {
      const workflow = {
        name: 'Test Workflow',
        nodes: [],
        connections: {}
      };

      const result = validator.validateWorkflowStructure(workflow);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('Missing settings object (optional but recommended)');
    });
  });

  describe('validateNodes', () => {
    it('should validate valid nodes array', () => {
      const nodes = [
        {
          id: 'node1',
          name: 'Node 1',
          type: 'n8n-nodes-base.httpRequest',
          position: [100, 200],
          parameters: {}
        }
      ];

      const result = validator.validateNodes(nodes);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.stats.totalNodes).toBe(1);
    });

    it('should detect duplicate node IDs', () => {
      const nodes = [
        {
          id: 'duplicate',
          name: 'Node 1',
          type: 'n8n-nodes-base.httpRequest',
          position: [100, 200],
          parameters: {}
        },
        {
          id: 'duplicate',
          name: 'Node 2',
          type: 'n8n-nodes-base.webhook',
          position: [300, 200],
          parameters: {}
        }
      ];

      const result = validator.validateNodes(nodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Duplicate node ID'))).toBe(true);
    });

    it('should detect duplicate node names', () => {
      const nodes = [
        {
          id: 'node1',
          name: 'Duplicate Name',
          type: 'n8n-nodes-base.httpRequest',
          position: [100, 200],
          parameters: {}
        },
        {
          id: 'node2',
          name: 'Duplicate Name',
          type: 'n8n-nodes-base.webhook',
          position: [300, 200],
          parameters: {}
        }
      ];

      const result = validator.validateNodes(nodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Duplicate node name'))).toBe(true);
    });

    it('should detect missing required fields', () => {
      const nodes = [
        {
          id: 'node1',
          name: 'Node 1'
          // Missing type and position
        }
      ];

      const result = validator.validateNodes(nodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing required field \'type\''))).toBe(true);
      expect(result.errors.some(e => e.includes('Missing required field \'position\''))).toBe(true);
    });

    it('should warn about unknown node types', () => {
      const nodes = [
        {
          id: 'node1',
          name: 'Node 1',
          type: 'n8n-nodes-base.unknownType',
          position: [100, 200],
          parameters: {}
        }
      ];

      const result = validator.validateNodes(nodes);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('Unknown node type'))).toBe(true);
    });

    it('should validate position format', () => {
      const nodes = [
        {
          id: 'node1',
          name: 'Node 1',
          type: 'n8n-nodes-base.httpRequest',
          position: [100], // Invalid - needs 2 elements
          parameters: {}
        }
      ];

      const result = validator.validateNodes(nodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Position must be an array of [x, y] coordinates'))).toBe(true);
    });

    it('should reject empty nodes array', () => {
      const result = validator.validateNodes([]);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Workflow must contain at least one node');
    });
  });

  describe('validateConnections', () => {
    const sampleNodes = [
      {
        id: 'webhook1',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        position: [0, 0],
        parameters: {}
      },
      {
        id: 'http1',
        name: 'HTTP Request',
        type: 'n8n-nodes-base.httpRequest',
        position: [200, 0],
        parameters: {}
      },
      {
        id: 'process1',
        name: 'Process',
        type: 'n8n-nodes-base.code',
        position: [400, 0],
        parameters: {}
      }
    ];

    it('should validate valid connections', () => {
      const connections = {
        'Webhook': {
          main: [[{
            node: 'HTTP Request',
            type: 'main',
            index: 0
          }]]
        },
        'HTTP Request': {
          main: [[{
            node: 'Process',
            type: 'main',
            index: 0
          }]]
        }
      };

      const result = validator.validateConnections(connections, sampleNodes);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.orphanedNodes).toHaveLength(0);
    });

    it('should detect orphaned nodes', () => {
      const connections = {
        'Webhook': {
          main: [[{
            node: 'HTTP Request',
            type: 'main',
            index: 0
          }]]
        }
        // Process node has no incoming connections and is not a trigger
      };

      const result = validator.validateConnections(connections, sampleNodes);

      expect(result.valid).toBe(true); // Warnings, not errors
      expect(result.orphanedNodes).toContain('Process');
      expect(result.warnings.some(w => w.includes('Orphaned node'))).toBe(true);
    });

    it('should detect connections to non-existent nodes', () => {
      const connections = {
        'Webhook': {
          main: [[{
            node: 'NonExistent',
            type: 'main',
            index: 0
          }]]
        }
      };

      const result = validator.validateConnections(connections, sampleNodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('does not match any node name'))).toBe(true);
    });

    it('should detect connections from non-existent source nodes', () => {
      const connections = {
        'NonExistentSource': {
          main: [[{
            node: 'HTTP Request',
            type: 'main',
            index: 0
          }]]
        }
      };

      const result = validator.validateConnections(connections, sampleNodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('does not match any node name'))).toBe(true);
    });

    it('should identify trigger nodes correctly', () => {
      const connections = {};
      const result = validator.validateConnections(connections, sampleNodes);

      expect(result.stats.triggerNodes).toContain('Webhook');
    });
  });

  describe('validateWebhooks', () => {
    it('should validate webhook with all required fields', () => {
      const nodes = [
        {
          id: 'webhook1',
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {
            httpMethod: 'POST',
            path: 'test-webhook',
            webhookId: 'test-webhook-id',
            responseMode: 'onReceived'
          }
        }
      ];

      const result = validator.validateWebhooks(nodes);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.webhooks).toHaveLength(1);
      expect(result.webhooks[0].method).toBe('POST');
    });

    it('should detect missing httpMethod', () => {
      const nodes = [
        {
          id: 'webhook1',
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {
            path: 'test-webhook'
          }
        }
      ];

      const result = validator.validateWebhooks(nodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Missing httpMethod'))).toBe(true);
    });

    it('should detect invalid httpMethod', () => {
      const nodes = [
        {
          id: 'webhook1',
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {
            httpMethod: 'INVALID',
            path: 'test-webhook'
          }
        }
      ];

      const result = validator.validateWebhooks(nodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid httpMethod'))).toBe(true);
    });

    it('should detect duplicate webhookIds', () => {
      const nodes = [
        {
          id: 'webhook1',
          name: 'Webhook 1',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {
            httpMethod: 'POST',
            path: 'webhook-1',
            webhookId: 'duplicate-id'
          }
        },
        {
          id: 'webhook2',
          name: 'Webhook 2',
          type: 'n8n-nodes-base.webhook',
          position: [200, 0],
          parameters: {
            httpMethod: 'GET',
            path: 'webhook-2',
            webhookId: 'duplicate-id'
          }
        }
      ];

      const result = validator.validateWebhooks(nodes);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Duplicate webhookId'))).toBe(true);
    });

    it('should warn about duplicate paths', () => {
      const nodes = [
        {
          id: 'webhook1',
          name: 'Webhook 1',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {
            httpMethod: 'POST',
            path: 'same-path',
            webhookId: 'id-1'
          }
        },
        {
          id: 'webhook2',
          name: 'Webhook 2',
          type: 'n8n-nodes-base.webhook',
          position: [200, 0],
          parameters: {
            httpMethod: 'POST',
            path: 'same-path',
            webhookId: 'id-2'
          }
        }
      ];

      const result = validator.validateWebhooks(nodes);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('Duplicate webhook path'))).toBe(true);
    });

    it('should warn about missing webhookId', () => {
      const nodes = [
        {
          id: 'webhook1',
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {
            httpMethod: 'POST',
            path: 'test-webhook'
          }
        }
      ];

      const result = validator.validateWebhooks(nodes);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('Missing webhookId'))).toBe(true);
    });

    it('should warn about no authentication', () => {
      const nodes = [
        {
          id: 'webhook1',
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {
            httpMethod: 'POST',
            path: 'test-webhook',
            webhookId: 'test-id',
            authentication: 'none'
          }
        }
      ];

      const result = validator.validateWebhooks(nodes);

      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes('no authentication'))).toBe(true);
    });
  });

  describe('generateValidationReport', () => {
    it('should generate comprehensive report for valid workflow', () => {
      const workflow = {
        name: 'Test Workflow',
        nodes: [
          {
            id: 'webhook1',
            name: 'Webhook',
            type: 'n8n-nodes-base.webhook',
            position: [0, 0],
            parameters: {
              httpMethod: 'POST',
              path: 'test',
              webhookId: 'test-id'
            }
          },
          {
            id: 'http1',
            name: 'HTTP Request',
            type: 'n8n-nodes-base.httpRequest',
            position: [200, 0],
            parameters: {}
          }
        ],
        connections: {
          'Webhook': {
            main: [[{
              node: 'HTTP Request',
              type: 'main',
              index: 0
            }]]
          }
        },
        settings: {}
      };

      const report = validator.generateValidationReport(workflow);

      expect(report).toHaveProperty('overall');
      expect(report).toHaveProperty('structure');
      expect(report).toHaveProperty('nodes');
      expect(report).toHaveProperty('connections');
      expect(report).toHaveProperty('webhooks');
      expect(report).toHaveProperty('graph');
      expect(report.overall.valid).toBe(true);
      expect(report.overall.score).toBeGreaterThan(0);
      expect(report.graph).toContain('Workflow Graph:');
    });

    it('should calculate overall validity correctly', () => {
      const invalidWorkflow = {
        name: 'Invalid',
        nodes: [
          {
            id: 'node1',
            name: 'Node 1',
            type: 'n8n-nodes-base.webhook'
            // Missing position and parameters
          }
        ],
        connections: {}
      };

      const report = validator.generateValidationReport(invalidWorkflow);

      expect(report.overall.valid).toBe(false);
      expect(report.allErrors.length).toBeGreaterThan(0);
    });

    it('should aggregate errors and warnings', () => {
      const workflow = {
        name: 'Test',
        nodes: [
          {
            id: 'duplicate',
            name: 'Node 1',
            type: 'n8n-nodes-base.unknownType',
            position: [0, 0],
            parameters: {}
          },
          {
            id: 'duplicate',
            name: 'Node 2',
            type: 'n8n-nodes-base.webhook',
            position: [200, 0],
            parameters: {}
          }
        ],
        connections: {}
      };

      const report = validator.generateValidationReport(workflow);

      expect(report.allErrors.length).toBeGreaterThan(0);
      expect(report.allWarnings.length).toBeGreaterThan(0);
    });
  });

  describe('isValid', () => {
    it('should return true for valid workflow', () => {
      const workflow = {
        name: 'Valid Workflow',
        nodes: [
          {
            id: 'node1',
            name: 'Node 1',
            type: 'n8n-nodes-base.webhook',
            position: [0, 0],
            parameters: {
              httpMethod: 'POST',
              path: 'test',
              webhookId: 'test-id'
            }
          }
        ],
        connections: {},
        settings: {}
      };

      expect(validator.isValid(workflow)).toBe(true);
    });

    it('should return false for invalid workflow', () => {
      const workflow = {
        name: 'Invalid',
        nodes: [],
        connections: {}
      };

      expect(validator.isValid(workflow)).toBe(false);
    });
  });

  describe('getValidationSummary', () => {
    it('should return summary with counts', () => {
      const workflow = {
        name: 'Test Workflow',
        nodes: [
          {
            id: 'webhook1',
            name: 'Webhook',
            type: 'n8n-nodes-base.webhook',
            position: [0, 0],
            parameters: {
              httpMethod: 'POST',
              path: 'test'
            }
          }
        ],
        connections: {},
        settings: {}
      };

      const summary = validator.getValidationSummary(workflow);

      expect(summary).toHaveProperty('valid');
      expect(summary).toHaveProperty('score');
      expect(summary).toHaveProperty('errors');
      expect(summary).toHaveProperty('warnings');
      expect(summary).toHaveProperty('nodes');
      expect(summary).toHaveProperty('webhooks');
      expect(summary.nodes).toBe(1);
      expect(summary.webhooks).toBe(1);
    });
  });
});
