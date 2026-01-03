/**
 * Workflow Deployment Wrapper for n8n workflows
 * Provides Node.js interface to bash deployment script with validation and retry logic
 * @module workflowDeployer
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const validator = require('./workflowValidator');

/**
 * ANSI color code regex for parsing colored bash output
 */
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * Strips ANSI color codes from text
 * @param {string} text - Text with ANSI codes
 * @returns {string} Cleaned text
 */
function stripAnsiCodes(text) {
  return text.replace(ANSI_REGEX, '');
}

/**
 * Parses ANSI colored output into structured data
 * @param {string} output - Raw bash output with colors
 * @returns {Object} Parsed output with sections
 */
function parseColoredOutput(output) {
  const lines = output.split('\n');
  const result = {
    rawOutput: output,
    cleanOutput: stripAnsiCodes(output),
    sections: {},
    errors: [],
    warnings: [],
    success: false
  };

  let currentSection = 'header';
  const sectionRegex = /\[(\d+)\/(\d+)\]/;

  lines.forEach(line => {
    const cleanLine = stripAnsiCodes(line);

    // Detect section headers
    const sectionMatch = cleanLine.match(sectionRegex);
    if (sectionMatch) {
      currentSection = `step_${sectionMatch[1]}`;
      result.sections[currentSection] = {
        step: parseInt(sectionMatch[1]),
        total: parseInt(sectionMatch[2]),
        lines: []
      };
    }

    // Add line to current section
    if (!result.sections[currentSection]) {
      result.sections[currentSection] = { lines: [] };
    }
    result.sections[currentSection].lines.push(cleanLine);

    // Detect errors and warnings
    if (cleanLine.includes('✗') || cleanLine.toLowerCase().includes('error')) {
      result.errors.push(cleanLine.trim());
    }
    if (cleanLine.includes('⚠') || cleanLine.toLowerCase().includes('warning')) {
      result.warnings.push(cleanLine.trim());
    }
    if (cleanLine.includes('Deployment Successful')) {
      result.success = true;
    }

    // Extract workflow ID
    const idMatch = cleanLine.match(/ID:\s*(\S+)/);
    if (idMatch) {
      result.workflowId = idMatch[1];
    }

    // Extract workflow name
    const nameMatch = cleanLine.match(/Workflow:\s*(.+)$/);
    if (nameMatch) {
      result.workflowName = nameMatch[1].trim();
    }
  });

  return result;
}

/**
 * Validates workflow before deployment
 * @param {Object} workflowJson - The workflow object to validate
 * @returns {Object} Validation result with { valid, report }
 */
function validateBeforeDeploy(workflowJson) {
  logger.info('Running pre-deployment validation');
  
  const report = validator.generateValidationReport(workflowJson);
  
  if (!report.overall.valid) {
    logger.error('Workflow validation failed', {
      errors: report.allErrors,
      warnings: report.allWarnings
    });
  } else {
    logger.info('Workflow validation passed', {
      score: report.overall.score,
      warnings: report.allWarnings.length
    });
  }

  return {
    valid: report.overall.valid,
    report
  };
}

/**
 * Deploys a workflow to n8n using the bash deployment script
 * @param {Object} workflowJson - The workflow object to deploy
 * @param {Object} options - Deployment options
 * @param {boolean} options.activate - Whether to activate after deployment (default: true)
 * @param {boolean} options.validate - Whether to validate before deployment (default: true)
 * @param {string} options.scriptPath - Path to deployment script (optional)
 * @returns {Promise<Object>} Deployment result
 */
async function deployWorkflow(workflowJson, options = {}) {
  const {
    activate = true,
    validate = true,
    scriptPath = path.join(__dirname, '../../scripts/deploy-workflow-auto.sh')
  } = options;

  logger.info('Starting workflow deployment', {
    workflowName: workflowJson?.name,
    activate,
    validate
  });

  // Step 1: Validate if requested
  if (validate) {
    const validationResult = validateBeforeDeploy(workflowJson);
    if (!validationResult.valid) {
      return {
        success: false,
        error: 'Validation failed',
        validation: validationResult.report,
        stage: 'validation'
      };
    }
  }

  // Step 2: Write workflow to temp file
  const tempDir = path.join(__dirname, '../../.tmp');
  await fs.mkdir(tempDir, { recursive: true });
  
  const timestamp = Date.now();
  const tempFile = path.join(tempDir, `workflow-${timestamp}.json`);
  
  try {
    await fs.writeFile(tempFile, JSON.stringify(workflowJson, null, 2), 'utf8');
    logger.info('Workflow written to temp file', { tempFile });

    // Step 3: Execute bash script
    const args = [tempFile];
    if (!activate) {
      args.push('--no-activate');
    }

    logger.info('Executing deployment script', { scriptPath, args });

    const result = await new Promise((resolve, reject) => {
      const process = spawn('bash', [scriptPath, ...args], {
        cwd: path.join(__dirname, '../..'),
        env: { ...process.env }
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr, code });
        } else {
          reject(new Error(`Deployment script exited with code ${code}`));
        }
      });

      process.on('error', (err) => {
        reject(err);
      });
    });

    // Step 4: Parse output
    const parsed = parseColoredOutput(result.stdout);
    
    logger.info('Deployment completed', {
      workflowId: parsed.workflowId,
      success: parsed.success,
      errors: parsed.errors.length,
      warnings: parsed.warnings.length
    });

    return {
      success: parsed.success,
      workflowId: parsed.workflowId,
      workflowName: parsed.workflowName,
      output: parsed,
      stage: 'deployment'
    };

  } catch (error) {
    logger.error('Deployment failed', {
      error: error.message,
      stack: error.stack
    });

    return {
      success: false,
      error: error.message,
      stage: 'execution'
    };
  } finally {
    // Step 5: Clean up temp file
    try {
      await fs.unlink(tempFile);
      logger.info('Cleaned up temp file', { tempFile });
    } catch (err) {
      logger.warn('Failed to clean up temp file', { tempFile, error: err.message });
    }
  }
}

/**
 * Deploys a workflow with retry logic and exponential backoff
 * @param {Object} workflowJson - The workflow object to deploy
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {Object} options - Deployment options (passed to deployWorkflow)
 * @returns {Promise<Object>} Deployment result
 */
async function deployWithRetry(workflowJson, maxRetries = 3, options = {}) {
  logger.info('Starting deployment with retry', {
    workflowName: workflowJson?.name,
    maxRetries
  });

  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger.info(`Deployment attempt ${attempt}/${maxRetries}`);

    try {
      const result = await deployWorkflow(workflowJson, options);
      
      if (result.success) {
        logger.info('Deployment succeeded', { attempt, workflowId: result.workflowId });
        return {
          ...result,
          attempts: attempt
        };
      }

      // Check if it's a validation error (don't retry)
      if (result.stage === 'validation') {
        logger.error('Validation error - not retrying', { error: result.error });
        return {
          ...result,
          attempts: attempt,
          retriesExhausted: false
        };
      }

      lastError = result.error;
      logger.warn('Deployment failed, will retry', {
        attempt,
        error: result.error,
        stage: result.stage
      });

    } catch (error) {
      lastError = error.message;
      logger.error('Deployment attempt failed with exception', {
        attempt,
        error: error.message
      });
    }

    // Exponential backoff before retry (except on last attempt)
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      logger.info(`Waiting ${delay}ms before retry`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  logger.error('All deployment attempts exhausted', {
    maxRetries,
    lastError
  });

  return {
    success: false,
    error: lastError || 'All deployment attempts failed',
    attempts: maxRetries,
    retriesExhausted: true
  };
}

/**
 * Rolls back a workflow by deleting it from n8n
 * @param {string} workflowId - The n8n workflow ID to delete
 * @param {Object} options - Rollback options
 * @param {string} options.n8nUrl - n8n instance URL (from env if not provided)
 * @param {string} options.n8nApiKey - n8n API key (from env if not provided)
 * @returns {Promise<Object>} Rollback result
 */
async function rollbackWorkflow(workflowId, options = {}) {
  const {
    n8nUrl = process.env.N8N_URL || 'https://n8n.specialblend.icu',
    n8nApiKey = process.env.N8N_API_KEY
  } = options;

  if (!n8nApiKey) {
    logger.error('N8N_API_KEY not available for rollback');
    return {
      success: false,
      error: 'N8N_API_KEY not configured'
    };
  }

  logger.info('Rolling back workflow', { workflowId, n8nUrl });

  try {
    // First, get workflow details (for backup/logging)
    const workflowResponse = await fetch(`${n8nUrl}/api/v1/workflows/${workflowId}`, {
      headers: {
        'X-N8N-API-KEY': n8nApiKey
      }
    });

    if (!workflowResponse.ok) {
      throw new Error(`Failed to fetch workflow: ${workflowResponse.statusText}`);
    }

    const workflowData = await workflowResponse.json();
    
    // Backup workflow data
    const backupDir = path.join(__dirname, '../../.backups');
    await fs.mkdir(backupDir, { recursive: true });
    
    const backupFile = path.join(backupDir, `rollback-${workflowId}-${Date.now()}.json`);
    await fs.writeFile(backupFile, JSON.stringify(workflowData, null, 2), 'utf8');
    
    logger.info('Workflow backed up', { backupFile });

    // Delete the workflow
    const deleteResponse = await fetch(`${n8nUrl}/api/v1/workflows/${workflowId}`, {
      method: 'DELETE',
      headers: {
        'X-N8N-API-KEY': n8nApiKey
      }
    });

    if (!deleteResponse.ok) {
      throw new Error(`Failed to delete workflow: ${deleteResponse.statusText}`);
    }

    logger.info('Workflow rolled back successfully', {
      workflowId,
      backupFile
    });

    return {
      success: true,
      workflowId,
      workflowName: workflowData.name,
      backupFile,
      message: 'Workflow deleted and backed up'
    };

  } catch (error) {
    logger.error('Rollback failed', {
      workflowId,
      error: error.message
    });

    return {
      success: false,
      workflowId,
      error: error.message
    };
  }
}

/**
 * Gets the status of a deployed workflow
 * @param {string} workflowId - The n8n workflow ID
 * @param {Object} options - Options with n8nUrl and n8nApiKey
 * @returns {Promise<Object>} Workflow status
 */
async function getWorkflowStatus(workflowId, options = {}) {
  const {
    n8nUrl = process.env.N8N_URL || 'https://n8n.specialblend.icu',
    n8nApiKey = process.env.N8N_API_KEY
  } = options;

  if (!n8nApiKey) {
    return {
      success: false,
      error: 'N8N_API_KEY not configured'
    };
  }

  try {
    const response = await fetch(`${n8nUrl}/api/v1/workflows/${workflowId}`, {
      headers: {
        'X-N8N-API-KEY': n8nApiKey
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch workflow: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      success: true,
      workflowId: data.id,
      name: data.name,
      active: data.active,
      tags: data.tags,
      updatedAt: data.updatedAt,
      createdAt: data.createdAt
    };

  } catch (error) {
    logger.error('Failed to get workflow status', {
      workflowId,
      error: error.message
    });

    return {
      success: false,
      workflowId,
      error: error.message
    };
  }
}

module.exports = {
  deployWorkflow,
  validateBeforeDeploy,
  deployWithRetry,
  rollbackWorkflow,
  getWorkflowStatus,
  // Export utilities for testing
  stripAnsiCodes,
  parseColoredOutput
};
