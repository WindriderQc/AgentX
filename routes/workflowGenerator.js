/**
 * Workflow Generator API Routes
 * Provides endpoints for generating n8n workflows using AI with RAG context
 * @module routes/workflowGenerator
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const logger = require('../config/logger');
const validator = require('../src/utils/workflowValidator');
const deployer = require('../src/utils/workflowDeployer');
const { handleChatRequest } = require('../src/services/chatService');

/**
 * Loads existing workflows from AgentC directory for RAG context
 * @returns {Promise<Array>} Array of workflow objects with metadata
 */
async function loadWorkflowContext() {
  const agentCDir = path.join(__dirname, '../AgentC');
  const workflowFiles = [];

  try {
    const files = await fs.readdir(agentCDir);
    
    for (const file of files) {
      if (file.endsWith('.json') && file.startsWith('N')) {
        try {
          const filePath = path.join(agentCDir, file);
          const content = await fs.readFile(filePath, 'utf8');
          const workflow = JSON.parse(content);
          
          workflowFiles.push({
            filename: file,
            name: workflow.name,
            nodeCount: workflow.nodes?.length || 0,
            hasWebhook: workflow.nodes?.some(n => n.type === 'n8n-nodes-base.webhook'),
            structure: {
              nodes: workflow.nodes?.map(n => ({
                type: n.type,
                name: n.name
              })),
              connectionCount: Object.keys(workflow.connections || {}).length
            },
            fullWorkflow: workflow // Include full workflow for reference
          });
        } catch (err) {
          logger.warn(`Failed to parse workflow file: ${file}`, { error: err.message });
        }
      }
    }

    logger.info('Loaded workflow context for RAG', { count: workflowFiles.length });
    return workflowFiles;

  } catch (err) {
    logger.error('Failed to load workflow context', { error: err.message });
    return [];
  }
}

/**
 * Builds a comprehensive prompt for the AI to generate a workflow
 * @param {string} description - Natural language description of desired workflow
 * @param {Array} templates - Optional array of template workflows
 * @param {Object} context - Additional context (existing workflows, constraints, etc.)
 * @param {Array} workflowExamples - Loaded workflow examples from AgentC
 * @returns {string} Formatted prompt for the AI
 */
function buildWorkflowPrompt(description, templates, context, workflowExamples) {
  const prompt = [];

  // Start with role and critical instructions
  prompt.push('# YOUR ROLE\n');
  prompt.push('You are an expert n8n workflow architect specialized in generating valid n8n workflow JSON.\n\n');
  
  prompt.push('# CRITICAL INSTRUCTIONS\n');
  prompt.push('- You MUST generate a complete, valid n8n workflow JSON\n');
  prompt.push('- Output the raw JSON object starting with { and ending with }\n');
  prompt.push('- Do NOT include markdown code fences or explanations\n');
  prompt.push('- Do NOT ask for clarification - make reasonable assumptions\n');
  prompt.push('- The workflow must follow SBQC naming: "SBQC - N[X.Y] Description"\n\n');
  
  prompt.push('# USER REQUIREMENTS\n');
  prompt.push(description);
  prompt.push('\n\n');

  // Add minimal examples if available
  if (workflowExamples && workflowExamples.length > 0) {
    prompt.push('# REFERENCE PATTERNS\n');
    prompt.push('Use these node types and patterns:\n');
    
    workflowExamples.slice(0, 2).forEach((example, idx) => {
      prompt.push(`- ${example.name}: ${example.structure.nodes.map(n => n.type.split('.').pop()).join(', ')}\n`);
    });
    prompt.push('\n');
  }

  // Add templates if provided
  if (templates && templates.length > 0) {
    prompt.push('# TEMPLATE TO FOLLOW\n');
    prompt.push('```json\n' + JSON.stringify(templates[0], null, 2) + '\n```\n\n');
  }

  // Core requirements
  prompt.push('# REQUIRED JSON STRUCTURE\n');
  prompt.push('Generate a workflow with this exact structure:\n');
  prompt.push('{\n');
  prompt.push('  "name": "SBQC - N[X.Y] [Description]",\n');
  prompt.push('  "nodes": [array of node objects with id, name, type, parameters, position],\n');
  prompt.push('  "connections": {object mapping node names to targets},\n');
  prompt.push('  "settings": {},\n');
  prompt.push('  "tags": [{"name": "SBQC"}],\n');
  prompt.push('  "active": false\n');
  prompt.push('}\n\n');

  prompt.push('# GENERATE NOW\n');
  prompt.push('Output the complete workflow JSON (raw JSON only, no other text):\n');

  return prompt.join('');
}

/**
 * Parses AI response to extract JSON workflow
 * @param {string} response - Raw response from AI
 * @returns {Object|null} Parsed workflow object or null if parsing fails
 */
function parseWorkflowFromResponse(response) {
  try {
    // First, try to parse directly
    return JSON.parse(response);
  } catch (err) {
    // Strategy 1: Extract from markdown code blocks
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (innerErr) {
        logger.debug('Failed to parse JSON from code block');
      }
    }

    // Strategy 2: Find the largest {..."name"...} object that looks like a workflow
    const workflowMatches = response.matchAll(/\{[\s\S]*?"name"\s*:\s*"SBQC[\s\S]*?\}/g);
    for (const match of workflowMatches) {
      try {
        // Try to find the complete JSON object by counting braces
        const startIdx = match.index;
        let braceCount = 0;
        let inString = false;
        let escape = false;
        let endIdx = startIdx;
        
        for (let i = startIdx; i < response.length; i++) {
          const char = response[i];
          
          if (escape) {
            escape = false;
            continue;
          }
          
          if (char === '\\') {
            escape = true;
            continue;
          }
          
          if (char === '"') {
            inString = !inString;
            continue;
          }
          
          if (!inString) {
            if (char === '{') braceCount++;
            if (char === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIdx = i + 1;
                break;
              }
            }
          }
        }
        
        if (endIdx > startIdx) {
          const jsonStr = response.substring(startIdx, endIdx);
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.name && parsed.nodes) {
              return parsed;
            }
          } catch (e) {
            logger.debug('Failed to parse extracted JSON block');
          }
        }
      } catch (e) {
        continue;
      }
    }

    // Strategy 3: Try to find ANY JSON object with basic structure check
    const startIdx = response.indexOf('{');
    const endIdx = response.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      try {
        const json = JSON.parse(response.substring(startIdx, endIdx + 1));
        // Validate it looks like a workflow
        if (json.nodes && json.connections) {
          return json;
        }
      } catch (innerErr) {
        logger.error('Failed to parse JSON from boundaries', { error: innerErr.message });
      }
    }

    logger.error('Could not extract valid JSON from response');
    return null;
  }
}

/**
 * POST /api/workflow/generate
 * Generates a new n8n workflow using AI
 * 
 * Request body:
 * {
 *   "description": "Natural language description of the workflow",
 *   "templates": [...],  // Optional: Array of template workflows
 *   "context": {...},    // Optional: Additional context
 *   "options": {
 *     "validate": true,  // Whether to validate generated workflow
 *     "deploy": false,   // Whether to deploy after generation
 *     "activate": false  // Whether to activate after deployment
 *   }
 * }
 * 
 * Response:
 * {
 *   "status": "success",
 *   "data": {
 *     "workflow": {...},           // Generated workflow JSON
 *     "validation": {...},         // Validation report
 *     "deployment": {...},         // Deployment result (if deployed)
 *     "suggestions": [...]         // Suggestions for improvement
 *   }
 * }
 */
router.post('/generate', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const {
      description,
      templates = [],
      context = {},
      options = {}
    } = req.body;

    // Validate input
    if (!description || typeof description !== 'string') {
      return res.status(400).json({
        status: 'error',
        message: 'Description is required and must be a string'
      });
    }

    logger.info('Workflow generation requested', {
      descriptionLength: description.length,
      hasTemplates: templates.length > 0,
      options
    });

    // Load workflow examples for RAG context
    const workflowExamples = await loadWorkflowContext();

    // Build comprehensive prompt
    const prompt = buildWorkflowPrompt(description, templates, context, workflowExamples);

    logger.info('Built workflow generation prompt', {
      promptLength: prompt.length,
      examplesCount: workflowExamples.length
    });

    // Call AI with everything in the message (no conflicting system prompt)
    const aiResponse = await handleChatRequest({
      message: prompt,
      conversationId: null,  // No conversation history
      userId: 'workflow-generator',
      model: 'qwen2.5:7b-instruct-q4_0',  
      system: null,  // No system prompt - everything is in the user message
      stream: false
    });

    if (!aiResponse || !aiResponse.response) {
      throw new Error('AI did not return a valid response');
    }

    logger.info('AI response received', {
      responseLength: aiResponse.response.length
    });

    // Parse workflow from response
    const workflow = parseWorkflowFromResponse(aiResponse.response);

    if (!workflow) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to parse valid workflow JSON from AI response',
        rawResponse: aiResponse.response.substring(0, 500) + '...'
      });
    }

    // Prepare response
    const result = {
      workflow,
      validation: null,
      deployment: null,
      suggestions: [],
      metadata: {
        generatedAt: new Date().toISOString(),
        generationTime: Date.now() - startTime,
        aiModel: aiResponse.model || 'unknown',
        promptTokens: prompt.length,
        examplesUsed: workflowExamples.length
      }
    };

    // Validate if requested (default: true)
    if (options.validate !== false) {
      logger.info('Validating generated workflow');
      result.validation = validator.generateValidationReport(workflow);

      // Generate suggestions based on validation
      if (result.validation.allWarnings.length > 0) {
        result.suggestions.push({
          type: 'warning',
          message: 'Consider addressing validation warnings for better workflow quality',
          warnings: result.validation.allWarnings
        });
      }

      if (!result.validation.overall.valid) {
        logger.warn('Generated workflow has validation errors', {
          errors: result.validation.allErrors
        });
        
        return res.status(400).json({
          status: 'error',
          message: 'Generated workflow failed validation',
          data: result
        });
      }
    }

    // Deploy if requested
    if (options.deploy === true) {
      logger.info('Deploying generated workflow');
      
      const deploymentResult = await deployer.deployWorkflow(workflow, {
        activate: options.activate || false,
        validate: false // Already validated above
      });

      result.deployment = deploymentResult;

      if (!deploymentResult.success) {
        return res.status(500).json({
          status: 'error',
          message: 'Workflow generated successfully but deployment failed',
          data: result
        });
      }
    }

    logger.info('Workflow generation completed successfully', {
      workflowName: workflow.name,
      validated: result.validation !== null,
      deployed: result.deployment !== null,
      totalTime: Date.now() - startTime
    });

    res.json({
      status: 'success',
      message: 'Workflow generated successfully',
      data: result
    });

  } catch (error) {
    logger.error('Workflow generation failed', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to generate workflow',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * POST /api/workflow/validate
 * Validates a workflow without generating or deploying
 */
router.post('/validate', async (req, res) => {
  try {
    const { workflow } = req.body;

    if (!workflow) {
      return res.status(400).json({
        status: 'error',
        message: 'Workflow object is required'
      });
    }

    logger.info('Workflow validation requested', {
      workflowName: workflow.name
    });

    const report = validator.generateValidationReport(workflow);

    res.json({
      status: 'success',
      data: report
    });

  } catch (error) {
    logger.error('Workflow validation failed', {
      error: error.message
    });

    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * POST /api/workflow/deploy
 * Deploys a workflow to n8n
 */
router.post('/deploy', async (req, res) => {
  try {
    const { workflow, options = {} } = req.body;

    if (!workflow) {
      return res.status(400).json({
        status: 'error',
        message: 'Workflow object is required'
      });
    }

    logger.info('Workflow deployment requested', {
      workflowName: workflow.name,
      options
    });

    const result = await deployer.deployWorkflow(workflow, options);

    if (!result.success) {
      return res.status(500).json({
        status: 'error',
        message: 'Deployment failed',
        data: result
      });
    }

    res.json({
      status: 'success',
      message: 'Workflow deployed successfully',
      data: result
    });

  } catch (error) {
    logger.error('Workflow deployment failed', {
      error: error.message
    });

    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * GET /api/workflow/examples
 * Returns example workflows from AgentC directory
 */
router.get('/examples', async (req, res) => {
  try {
    const examples = await loadWorkflowContext();

    // Remove full workflow data to keep response size manageable
    const lightExamples = examples.map(ex => ({
      filename: ex.filename,
      name: ex.name,
      nodeCount: ex.nodeCount,
      hasWebhook: ex.hasWebhook,
      nodeTypes: ex.structure.nodes.map(n => n.type.split('.').pop())
    }));

    res.json({
      status: 'success',
      data: {
        count: lightExamples.length,
        examples: lightExamples
      }
    });

  } catch (error) {
    logger.error('Failed to load workflow examples', {
      error: error.message
    });

    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router;
