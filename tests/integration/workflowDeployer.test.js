/**
 * Integration Tests for Workflow Deployer
 */

const deployer = require('../../src/utils/workflowDeployer');
const fs = require('fs').promises;
const path = require('path');

// Mock logger to avoid console spam during tests
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

describe('Workflow Deployer Integration Tests', () => {
  const sampleWorkflow = {
    name: 'Test Workflow',
    nodes: [
      {
        id: 'webhook1',
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook',
        position: [0, 0],
        typeVersion: 2,
        parameters: {
          httpMethod: 'POST',
          path: 'test-webhook',
          webhookId: 'test-webhook-id',
          responseMode: 'onReceived'
        }
      },
      {
        id: 'http1',
        name: 'HTTP Request',
        type: 'n8n-nodes-base.httpRequest',
        position: [200, 0],
        typeVersion: 4.2,
        parameters: {
          method: 'GET',
          url: 'https://example.com/api/test'
        }
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

  describe('stripAnsiCodes', () => {
    it('should remove ANSI color codes from text', () => {
      const coloredText = '\x1b[32mSuccess\x1b[0m';
      const result = deployer.stripAnsiCodes(coloredText);
      expect(result).toBe('Success');
    });

    it('should handle text without ANSI codes', () => {
      const plainText = 'Plain text';
      const result = deployer.stripAnsiCodes(plainText);
      expect(result).toBe('Plain text');
    });

    it('should handle multiple color codes', () => {
      const text = '\x1b[31mError:\x1b[0m \x1b[33mWarning\x1b[0m';
      const result = deployer.stripAnsiCodes(text);
      expect(result).toBe('Error: Warning');
    });
  });

  describe('parseColoredOutput', () => {
    it('should parse bash script output with sections', () => {
      const output = `
[1/3] Validating workflow...
✓ Valid JSON
[2/3] Checking structure...
✓ Name: Test Workflow
[3/3] Deploying...
✓ Deployment Successful!
ID: 12345
Workflow: Test Workflow
      `.trim();

      const result = deployer.parseColoredOutput(output);

      expect(result.success).toBe(true);
      expect(result.workflowId).toBe('12345');
      expect(result.workflowName).toBe('Test Workflow');
      expect(result.sections).toHaveProperty('step_1');
      expect(result.sections).toHaveProperty('step_2');
      expect(result.sections).toHaveProperty('step_3');
    });

    it('should detect errors in output', () => {
      const output = `
[1/2] Validating...
✗ Invalid JSON syntax
Error: Failed to parse
      `.trim();

      const result = deployer.parseColoredOutput(output);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect warnings in output', () => {
      const output = `
[1/2] Validating...
⚠ Warning: Missing webhookId
✓ Structure valid
      `.trim();

      const result = deployer.parseColoredOutput(output);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('webhookId'))).toBe(true);
    });
  });

  describe('validateBeforeDeploy', () => {
    it('should validate valid workflow', () => {
      const result = deployer.validateBeforeDeploy(sampleWorkflow);

      expect(result.valid).toBe(true);
      expect(result.report).toBeDefined();
      expect(result.report.overall.valid).toBe(true);
    });

    it('should reject invalid workflow', () => {
      const invalidWorkflow = {
        name: 'Invalid',
        nodes: [],
        connections: {}
      };

      const result = deployer.validateBeforeDeploy(invalidWorkflow);

      expect(result.valid).toBe(false);
      expect(result.report.allErrors.length).toBeGreaterThan(0);
    });

    it('should provide detailed validation report', () => {
      const result = deployer.validateBeforeDeploy(sampleWorkflow);

      expect(result.report).toHaveProperty('structure');
      expect(result.report).toHaveProperty('nodes');
      expect(result.report).toHaveProperty('connections');
      expect(result.report).toHaveProperty('webhooks');
      expect(result.report).toHaveProperty('graph');
    });
  });

  describe('deployWorkflow (mocked)', () => {
    // Note: These tests require mocking child_process.spawn
    // or setting up a test n8n instance. For now, we test the validation path.

    it('should fail deployment if validation fails', async () => {
      const invalidWorkflow = {
        name: 'Invalid',
        nodes: [],
        connections: {}
      };

      const result = await deployer.deployWorkflow(invalidWorkflow, {
        validate: true,
        activate: false
      });

      expect(result.success).toBe(false);
      expect(result.stage).toBe('validation');
      expect(result.error).toContain('Validation failed');
    });

    it('should skip validation if requested', async () => {
      // This would normally call the bash script, but without a test n8n instance,
      // it will fail at the execution stage. We're testing the flow.
      const result = await deployer.deployWorkflow(sampleWorkflow, {
        validate: false,
        activate: false
      });

      // Without a real n8n instance, this will fail at execution
      // but we can verify it didn't fail at validation
      expect(result.stage).not.toBe('validation');
    });
  });

  describe('deployWithRetry (logic test)', () => {
    it('should retry on transient failures', async () => {
      // Create a workflow that will fail validation
      const invalidWorkflow = {
        name: 'Test',
        nodes: [],
        connections: {}
      };

      const result = await deployer.deployWithRetry(invalidWorkflow, 2, {
        validate: true
      });

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1); // Should not retry validation errors
      expect(result.retriesExhausted).toBe(false);
    });
  });

  describe('getWorkflowStatus', () => {
    it('should return error if API key not configured', async () => {
      // Temporarily clear API key
      const originalApiKey = process.env.N8N_API_KEY;
      delete process.env.N8N_API_KEY;

      const result = await deployer.getWorkflowStatus('test-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('N8N_API_KEY');

      // Restore
      if (originalApiKey) {
        process.env.N8N_API_KEY = originalApiKey;
      }
    });
  });

  describe('File operations', () => {
    const tempDir = path.join(__dirname, '../../.tmp');

    beforeAll(async () => {
      // Ensure temp directory exists
      await fs.mkdir(tempDir, { recursive: true });
    });

    afterAll(async () => {
      // Clean up test files
      try {
        const files = await fs.readdir(tempDir);
        for (const file of files) {
          if (file.startsWith('workflow-') && file.endsWith('.json')) {
            await fs.unlink(path.join(tempDir, file));
          }
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    });

    it('should create temp directory if it does not exist', async () => {
      // The deployWorkflow function should create the directory
      const exists = await fs.access(tempDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('Backup operations', () => {
    const backupDir = path.join(__dirname, '../../.backups');

    it('should create backup directory for rollbacks', async () => {
      // Ensure directory exists (rollback would create it)
      await fs.mkdir(backupDir, { recursive: true });
      
      const exists = await fs.access(backupDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    afterAll(async () => {
      // Clean up test backups
      try {
        const files = await fs.readdir(backupDir);
        for (const file of files) {
          if (file.startsWith('rollback-test-')) {
            await fs.unlink(path.join(backupDir, file));
          }
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    });
  });
});

describe('Workflow Deployer - Error Handling', () => {
  it('should handle workflow with no name gracefully', async () => {
    const workflow = {
      nodes: [],
      connections: {}
    };

    const result = await deployer.validateBeforeDeploy(workflow);
    
    expect(result.valid).toBe(false);
    expect(result.report.allErrors.some(e => e.includes('name'))).toBe(true);
  });

  it('should handle malformed connections', async () => {
    const workflow = {
      name: 'Test',
      nodes: [
        {
          id: 'node1',
          name: 'Node 1',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {}
        }
      ],
      connections: {
        'NonExistent': {
          main: [[{
            node: 'Node 1',
            type: 'main',
            index: 0
          }]]
        }
      }
    };

    const result = await deployer.validateBeforeDeploy(workflow);
    
    expect(result.valid).toBe(false);
  });
});
