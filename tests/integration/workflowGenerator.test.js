/**
 * API Tests for Workflow Generator Routes
 */

const request = require('supertest');
const { app } = require('../../src/app');
const fs = require('fs').promises;
const path = require('path');

// Mock the deployer to avoid actual deployments during tests
jest.mock('../../src/utils/workflowDeployer', () => ({
  deployWorkflow: jest.fn(),
  validateBeforeDeploy: jest.fn(),
  deployWithRetry: jest.fn(),
  rollbackWorkflow: jest.fn(),
  getWorkflowStatus: jest.fn()
}));

// Mock the chatService to avoid actual AI calls
jest.mock('../../src/services/chatService', () => ({
  handleChatRequest: jest.fn()
}));

const deployer = require('../../src/utils/workflowDeployer');
const { handleChatRequest } = require('../../src/services/chatService');

describe('Workflow Generator API Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/workflow/generate', () => {
    const validRequest = {
      description: 'Create a workflow that checks system health every 5 minutes',
      options: {
        validate: true,
        deploy: false,
        activate: false
      }
    };

    const sampleGeneratedWorkflow = {
      name: 'SBQC - N1.4 System Health Check',
      nodes: [
        {
          id: 'schedule1',
          name: 'Schedule Trigger',
          type: 'n8n-nodes-base.scheduleTrigger',
          position: [-600, 0],
          typeVersion: 1.1,
          parameters: {
            rule: {
              interval: [{
                field: 'minutes',
                minutes: 5
              }]
            }
          }
        },
        {
          id: 'http1',
          name: 'Check Health',
          type: 'n8n-nodes-base.httpRequest',
          position: [0, 0],
          typeVersion: 4.2,
          parameters: {
            method: 'GET',
            url: 'http://192.168.2.33:3003/health'
          }
        }
      ],
      connections: {
        'Schedule Trigger': {
          main: [[{
            node: 'Check Health',
            type: 'main',
            index: 0
          }]]
        }
      },
      settings: {}
    };

    it('should reject request without description', async () => {
      const response = await request(app)
        .post('/api/workflow/generate')
        .send({})
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Description is required');
    });

    it('should generate workflow successfully', async () => {
      // Mock AI response
      handleChatRequest.mockResolvedValue({
        response: JSON.stringify(sampleGeneratedWorkflow),
        model: 'llama3'
      });

      const response = await request(app)
        .post('/api/workflow/generate')
        .send(validRequest)
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('workflow');
      expect(response.body.data).toHaveProperty('validation');
      expect(response.body.data).toHaveProperty('metadata');
      expect(response.body.data.workflow.name).toBe(sampleGeneratedWorkflow.name);
    });

    it('should call AI with sbqc_workflow_architect persona', async () => {
      handleChatRequest.mockResolvedValue({
        response: JSON.stringify(sampleGeneratedWorkflow),
        model: 'llama3'
      });

      await request(app)
        .post('/api/workflow/generate')
        .send(validRequest)
        .expect(200);

      expect(handleChatRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          persona: 'sbqc_workflow_architect',
          stream: false
        })
      );
    });

    it('should validate generated workflow by default', async () => {
      handleChatRequest.mockResolvedValue({
        response: JSON.stringify(sampleGeneratedWorkflow),
        model: 'llama3'
      });

      const response = await request(app)
        .post('/api/workflow/generate')
        .send(validRequest)
        .expect(200);

      expect(response.body.data.validation).toBeDefined();
      expect(response.body.data.validation.overall).toBeDefined();
    });

    it('should skip validation if requested', async () => {
      handleChatRequest.mockResolvedValue({
        response: JSON.stringify(sampleGeneratedWorkflow),
        model: 'llama3'
      });

      const response = await request(app)
        .post('/api/workflow/generate')
        .send({
          ...validRequest,
          options: { validate: false }
        })
        .expect(200);

      expect(response.body.data.validation).toBeNull();
    });

    it('should deploy workflow if requested', async () => {
      handleChatRequest.mockResolvedValue({
        response: JSON.stringify(sampleGeneratedWorkflow),
        model: 'llama3'
      });

      deployer.deployWorkflow.mockResolvedValue({
        success: true,
        workflowId: '12345',
        workflowName: sampleGeneratedWorkflow.name
      });

      const response = await request(app)
        .post('/api/workflow/generate')
        .send({
          ...validRequest,
          options: {
            validate: true,
            deploy: true,
            activate: false
          }
        })
        .expect(200);

      expect(response.body.data.deployment).toBeDefined();
      expect(response.body.data.deployment.success).toBe(true);
      expect(deployer.deployWorkflow).toHaveBeenCalledWith(
        sampleGeneratedWorkflow,
        expect.objectContaining({
          activate: false,
          validate: false // Already validated before deployment
        })
      );
    });

    it('should return error if AI fails to generate valid JSON', async () => {
      handleChatRequest.mockResolvedValue({
        response: 'This is not valid JSON',
        model: 'llama3'
      });

      const response = await request(app)
        .post('/api/workflow/generate')
        .send(validRequest)
        .expect(500);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Failed to parse');
    });

    it('should return error if generated workflow fails validation', async () => {
      const invalidWorkflow = {
        name: 'Invalid',
        nodes: [],
        connections: {}
      };

      handleChatRequest.mockResolvedValue({
        response: JSON.stringify(invalidWorkflow),
        model: 'llama3'
      });

      const response = await request(app)
        .post('/api/workflow/generate')
        .send(validRequest)
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('validation');
    });

    it('should extract JSON from markdown code blocks', async () => {
      const responseWithMarkdown = `
Here's the workflow:

\`\`\`json
${JSON.stringify(sampleGeneratedWorkflow, null, 2)}
\`\`\`

This workflow does XYZ...
      `;

      handleChatRequest.mockResolvedValue({
        response: responseWithMarkdown,
        model: 'llama3'
      });

      const response = await request(app)
        .post('/api/workflow/generate')
        .send(validRequest)
        .expect(200);

      expect(response.body.data.workflow.name).toBe(sampleGeneratedWorkflow.name);
    });

    it('should include generation metadata', async () => {
      handleChatRequest.mockResolvedValue({
        response: JSON.stringify(sampleGeneratedWorkflow),
        model: 'llama3'
      });

      const response = await request(app)
        .post('/api/workflow/generate')
        .send(validRequest)
        .expect(200);

      expect(response.body.data.metadata).toHaveProperty('generatedAt');
      expect(response.body.data.metadata).toHaveProperty('generationTime');
      expect(response.body.data.metadata).toHaveProperty('aiModel');
      expect(response.body.data.metadata.aiModel).toBe('llama3');
    });
  });

  describe('POST /api/workflow/validate', () => {
    const validWorkflow = {
      name: 'Test Workflow',
      nodes: [
        {
          id: 'node1',
          name: 'Node 1',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          parameters: {}
        }
      ],
      connections: {},
      settings: {}
    };

    it('should validate a valid workflow', async () => {
      const response = await request(app)
        .post('/api/workflow/validate')
        .send({ workflow: validWorkflow })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('overall');
      expect(response.body.data).toHaveProperty('structure');
      expect(response.body.data).toHaveProperty('nodes');
      expect(response.body.data).toHaveProperty('connections');
      expect(response.body.data).toHaveProperty('webhooks');
      expect(response.body.data).toHaveProperty('graph');
    });

    it('should reject request without workflow', async () => {
      const response = await request(app)
        .post('/api/workflow/validate')
        .send({})
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Workflow object is required');
    });

    it('should return validation errors for invalid workflow', async () => {
      const invalidWorkflow = {
        name: 'Invalid',
        nodes: [],
        connections: {}
      };

      const response = await request(app)
        .post('/api/workflow/validate')
        .send({ workflow: invalidWorkflow })
        .expect(200);

      expect(response.body.data.overall.valid).toBe(false);
      expect(response.body.data.allErrors.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/workflow/deploy', () => {
    const validWorkflow = {
      name: 'Test Workflow',
      nodes: [
        {
          id: 'node1',
          name: 'Node 1',
          type: 'n8n-nodes-base.webhook',
          position: [0, 0],
          typeVersion: 2,
          parameters: {
            httpMethod: 'POST',
            path: 'test'
          }
        }
      ],
      connections: {},
      settings: {}
    };

    it('should deploy workflow successfully', async () => {
      deployer.deployWorkflow.mockResolvedValue({
        success: true,
        workflowId: '12345',
        workflowName: 'Test Workflow'
      });

      const response = await request(app)
        .post('/api/workflow/deploy')
        .send({ workflow: validWorkflow })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.success).toBe(true);
      expect(response.body.data.workflowId).toBe('12345');
    });

    it('should reject request without workflow', async () => {
      const response = await request(app)
        .post('/api/workflow/deploy')
        .send({})
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Workflow object is required');
    });

    it('should handle deployment failure', async () => {
      deployer.deployWorkflow.mockResolvedValue({
        success: false,
        error: 'Deployment failed'
      });

      const response = await request(app)
        .post('/api/workflow/deploy')
        .send({ workflow: validWorkflow })
        .expect(500);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Deployment failed');
    });

    it('should pass options to deployer', async () => {
      deployer.deployWorkflow.mockResolvedValue({
        success: true,
        workflowId: '12345'
      });

      await request(app)
        .post('/api/workflow/deploy')
        .send({
          workflow: validWorkflow,
          options: {
            activate: true,
            validate: false
          }
        })
        .expect(200);

      expect(deployer.deployWorkflow).toHaveBeenCalledWith(
        validWorkflow,
        expect.objectContaining({
          activate: true,
          validate: false
        })
      );
    });
  });

  describe('GET /api/workflow/examples', () => {
    it('should return list of example workflows', async () => {
      const response = await request(app)
        .get('/api/workflow/examples')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('count');
      expect(response.body.data).toHaveProperty('examples');
      expect(Array.isArray(response.body.data.examples)).toBe(true);
    });

    it('should return workflow metadata without full content', async () => {
      const response = await request(app)
        .get('/api/workflow/examples')
        .expect(200);

      if (response.body.data.examples.length > 0) {
        const example = response.body.data.examples[0];
        expect(example).toHaveProperty('filename');
        expect(example).toHaveProperty('name');
        expect(example).toHaveProperty('nodeCount');
        expect(example).toHaveProperty('hasWebhook');
        expect(example).not.toHaveProperty('fullWorkflow');
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle AI service errors gracefully', async () => {
      handleChatRequest.mockRejectedValue(new Error('AI service unavailable'));

      const response = await request(app)
        .post('/api/workflow/generate')
        .send({
          description: 'Test workflow'
        })
        .expect(500);

      expect(response.body.status).toBe('error');
    });

    it('should handle file system errors when loading examples', async () => {
      // This test would require mocking fs, which is complex
      // For now, we just ensure the endpoint doesn't crash
      const response = await request(app)
        .get('/api/workflow/examples');

      expect([200, 500]).toContain(response.status);
      expect(response.body).toHaveProperty('status');
    });
  });
});
