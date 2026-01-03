/**
 * Workflow Validator for n8n workflows
 * Provides comprehensive validation for workflow structure, nodes, connections, and webhooks
 * @module workflowValidator
 */

const logger = require('./logger');

/**
 * Known n8n node types (common ones - extend as needed)
 */
const KNOWN_NODE_TYPES = [
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.set',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.code',
  'n8n-nodes-base.function',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.start',
  'n8n-nodes-base.executeWorkflow',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.loop',
  'n8n-nodes-base.aggregate',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.noOp',
];

/**
 * Valid webhook HTTP methods
 */
const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/**
 * Valid webhook response modes
 */
const VALID_RESPONSE_MODES = ['onReceived', 'lastNode', 'responseNode'];

/**
 * Validates the overall structure of a workflow
 * @param {Object} workflow - The workflow object to validate
 * @returns {Object} Validation result with { valid, errors, warnings }
 */
function validateWorkflowStructure(workflow) {
  const errors = [];
  const warnings = [];

  // Check if workflow exists
  if (!workflow || typeof workflow !== 'object') {
    errors.push('Workflow must be a valid object');
    return { valid: false, errors, warnings };
  }

  // Check required top-level fields
  const requiredFields = ['name', 'nodes', 'connections'];
  requiredFields.forEach(field => {
    if (!workflow[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  });

  // Validate name
  if (workflow.name) {
    if (typeof workflow.name !== 'string') {
      errors.push('Workflow name must be a string');
    } else if (workflow.name.trim().length === 0) {
      errors.push('Workflow name cannot be empty');
    }
  }

  // Validate nodes is an array
  if (workflow.nodes && !Array.isArray(workflow.nodes)) {
    errors.push('Nodes must be an array');
  }

  // Validate connections is an object
  if (workflow.connections && typeof workflow.connections !== 'object') {
    errors.push('Connections must be an object');
  }

  // Check for settings (optional but recommended)
  if (!workflow.settings) {
    warnings.push('Missing settings object (optional but recommended)');
  }

  // Validate settings structure if present
  if (workflow.settings && typeof workflow.settings !== 'object') {
    errors.push('Settings must be an object');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validates all nodes in the workflow
 * @param {Array} nodes - Array of node objects
 * @returns {Object} Validation result with { valid, errors, warnings }
 */
function validateNodes(nodes) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(nodes)) {
    errors.push('Nodes must be an array');
    return { valid: false, errors, warnings };
  }

  if (nodes.length === 0) {
    errors.push('Workflow must contain at least one node');
    return { valid: false, errors, warnings };
  }

  const nodeIds = new Set();
  const nodeNames = new Set();

  nodes.forEach((node, index) => {
    const nodePrefix = `Node[${index}]`;

    // Check required fields
    const requiredFields = ['id', 'name', 'type', 'position'];
    requiredFields.forEach(field => {
      if (!node[field]) {
        errors.push(`${nodePrefix}: Missing required field '${field}'`);
      }
    });

    // Validate id uniqueness
    if (node.id) {
      if (nodeIds.has(node.id)) {
        errors.push(`${nodePrefix}: Duplicate node ID '${node.id}'`);
      }
      nodeIds.add(node.id);
    }

    // Validate name uniqueness
    if (node.name) {
      if (nodeNames.has(node.name)) {
        errors.push(`${nodePrefix}: Duplicate node name '${node.name}'`);
      }
      nodeNames.add(node.name);
    }

    // Validate node type
    if (node.type) {
      if (typeof node.type !== 'string') {
        errors.push(`${nodePrefix}: Node type must be a string`);
      } else if (!KNOWN_NODE_TYPES.includes(node.type)) {
        warnings.push(`${nodePrefix}: Unknown node type '${node.type}' (may be valid but not in known types list)`);
      }
    }

    // Validate position
    if (node.position) {
      if (!Array.isArray(node.position) || node.position.length !== 2) {
        errors.push(`${nodePrefix}: Position must be an array of [x, y] coordinates`);
      } else {
        const [x, y] = node.position;
        if (typeof x !== 'number' || typeof y !== 'number') {
          errors.push(`${nodePrefix}: Position coordinates must be numbers`);
        }
      }
    }

    // Validate parameters (should exist, even if empty object)
    if (node.parameters === undefined) {
      warnings.push(`${nodePrefix}: Missing parameters object`);
    } else if (typeof node.parameters !== 'object') {
      errors.push(`${nodePrefix}: Parameters must be an object`);
    }

    // Check typeVersion
    if (!node.typeVersion) {
      warnings.push(`${nodePrefix}: Missing typeVersion (recommended)`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      totalNodes: nodes.length,
      uniqueIds: nodeIds.size,
      uniqueNames: nodeNames.size
    }
  };
}

/**
 * Validates workflow connections and detects orphaned nodes
 * @param {Object} connections - Connections object from workflow
 * @param {Array} nodes - Array of node objects
 * @returns {Object} Validation result with { valid, errors, warnings, orphanedNodes }
 */
function validateConnections(connections, nodes) {
  const errors = [];
  const warnings = [];
  const orphanedNodes = [];

  if (!connections || typeof connections !== 'object') {
    errors.push('Connections must be an object');
    return { valid: false, errors, warnings, orphanedNodes };
  }

  if (!Array.isArray(nodes)) {
    errors.push('Nodes must be an array for connection validation');
    return { valid: false, errors, warnings, orphanedNodes };
  }

  // Build node name map
  const nodeMap = new Map();
  const triggerTypes = ['n8n-nodes-base.webhook', 'n8n-nodes-base.cron', 'n8n-nodes-base.start'];
  const triggerNodes = new Set();

  nodes.forEach(node => {
    nodeMap.set(node.name, node);
    if (triggerTypes.includes(node.type)) {
      triggerNodes.add(node.name);
    }
  });

  // Track which nodes have incoming connections
  const nodesWithIncoming = new Set();

  // Validate each connection
  Object.keys(connections).forEach(sourceName => {
    const sourceNode = nodeMap.get(sourceName);
    
    if (!sourceNode) {
      errors.push(`Connection source '${sourceName}' does not match any node name`);
      return;
    }

    const connectionData = connections[sourceName];
    
    if (typeof connectionData !== 'object') {
      errors.push(`Connection data for '${sourceName}' must be an object`);
      return;
    }

    // Validate connection outputs (usually 'main')
    Object.keys(connectionData).forEach(outputType => {
      const outputs = connectionData[outputType];
      
      if (!Array.isArray(outputs)) {
        errors.push(`Connection outputs for '${sourceName}.${outputType}' must be an array`);
        return;
      }

      outputs.forEach((outputArray, outputIndex) => {
        if (!Array.isArray(outputArray)) {
          errors.push(`Connection output '${sourceName}.${outputType}[${outputIndex}]' must be an array`);
          return;
        }

        outputArray.forEach((connection, connIndex) => {
          // Validate connection structure
          if (!connection.node) {
            errors.push(`Connection '${sourceName}.${outputType}[${outputIndex}][${connIndex}]' missing 'node' field`);
            return;
          }

          const targetNode = nodeMap.get(connection.node);
          if (!targetNode) {
            errors.push(`Connection target '${connection.node}' from '${sourceName}' does not match any node name`);
          } else {
            nodesWithIncoming.add(connection.node);
          }

          // Validate connection type (usually 'main')
          if (!connection.type) {
            warnings.push(`Connection '${sourceName}' -> '${connection.node}' missing 'type' field`);
          }

          // Validate connection index
          if (connection.index === undefined) {
            warnings.push(`Connection '${sourceName}' -> '${connection.node}' missing 'index' field`);
          }
        });
      });
    });
  });

  // Detect orphaned nodes (nodes with no incoming connections, excluding triggers)
  nodes.forEach(node => {
    if (!triggerNodes.has(node.name) && !nodesWithIncoming.has(node.name)) {
      orphanedNodes.push(node.name);
      warnings.push(`Orphaned node detected: '${node.name}' has no incoming connections and is not a trigger`);
    }
  });

  // Check if there's at least one trigger node
  if (triggerNodes.size === 0) {
    warnings.push('No trigger nodes found (webhook, cron, or start). Workflow may not execute.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    orphanedNodes,
    stats: {
      totalConnections: Object.keys(connections).length,
      triggerNodes: Array.from(triggerNodes),
      nodesWithIncoming: nodesWithIncoming.size,
      orphanedCount: orphanedNodes.length
    }
  };
}

/**
 * Validates webhook nodes in the workflow
 * @param {Array} nodes - Array of node objects
 * @returns {Object} Validation result with { valid, errors, warnings, webhooks }
 */
function validateWebhooks(nodes) {
  const errors = [];
  const warnings = [];
  const webhooks = [];

  if (!Array.isArray(nodes)) {
    errors.push('Nodes must be an array');
    return { valid: false, errors, warnings, webhooks };
  }

  const webhookIds = new Set();
  const webhookPaths = new Set();

  nodes.forEach((node, index) => {
    if (node.type !== 'n8n-nodes-base.webhook') {
      return;
    }

    const nodePrefix = `Webhook[${node.name || index}]`;
    const params = node.parameters || {};

    // Check required webhook fields
    if (!params.httpMethod) {
      errors.push(`${nodePrefix}: Missing httpMethod`);
    } else if (!VALID_HTTP_METHODS.includes(params.httpMethod)) {
      errors.push(`${nodePrefix}: Invalid httpMethod '${params.httpMethod}'. Must be one of: ${VALID_HTTP_METHODS.join(', ')}`);
    }

    if (!params.path) {
      errors.push(`${nodePrefix}: Missing path`);
    } else {
      // Check for duplicate paths (warning, as different methods can use same path)
      const pathKey = `${params.httpMethod}:${params.path}`;
      if (webhookPaths.has(pathKey)) {
        warnings.push(`${nodePrefix}: Duplicate webhook path '${params.httpMethod} ${params.path}'`);
      }
      webhookPaths.add(pathKey);
    }

    // Validate webhookId if present
    if (params.webhookId) {
      if (typeof params.webhookId !== 'string') {
        errors.push(`${nodePrefix}: webhookId must be a string`);
      } else {
        // Check uniqueness
        if (webhookIds.has(params.webhookId)) {
          errors.push(`${nodePrefix}: Duplicate webhookId '${params.webhookId}'`);
        }
        webhookIds.add(params.webhookId);

        // Check naming convention (if any - adjust as needed)
        if (!/^[a-zA-Z0-9-_]+$/.test(params.webhookId)) {
          warnings.push(`${nodePrefix}: webhookId '${params.webhookId}' contains special characters. Consider using only alphanumeric, hyphens, and underscores.`);
        }
      }
    } else {
      warnings.push(`${nodePrefix}: Missing webhookId (recommended for tracking)`);
    }

    // Validate responseMode
    if (params.responseMode) {
      if (!VALID_RESPONSE_MODES.includes(params.responseMode)) {
        errors.push(`${nodePrefix}: Invalid responseMode '${params.responseMode}'. Must be one of: ${VALID_RESPONSE_MODES.join(', ')}`);
      }
    } else {
      warnings.push(`${nodePrefix}: Missing responseMode (defaults to 'onReceived')`);
    }

    // Validate authentication settings
    if (params.authentication === 'none') {
      warnings.push(`${nodePrefix}: Webhook has no authentication. Consider adding security.`);
    }

    webhooks.push({
      name: node.name,
      method: params.httpMethod,
      path: params.path,
      webhookId: params.webhookId,
      responseMode: params.responseMode || 'onReceived',
      authentication: params.authentication || 'none'
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    webhooks,
    stats: {
      totalWebhooks: webhooks.length,
      uniqueIds: webhookIds.size,
      uniquePaths: webhookPaths.size
    }
  };
}

/**
 * Generates a comprehensive validation report for a workflow
 * @param {Object} workflow - The complete workflow object
 * @returns {Object} Detailed validation report with ASCII graph visualization
 */
function generateValidationReport(workflow) {
  const report = {
    timestamp: new Date().toISOString(),
    workflowName: workflow?.name || 'Unknown',
    overall: { valid: true, score: 100 },
    structure: {},
    nodes: {},
    connections: {},
    webhooks: {},
    allErrors: [],
    allWarnings: [],
    graph: ''
  };

  // Validate structure
  report.structure = validateWorkflowStructure(workflow);
  report.allErrors.push(...report.structure.errors);
  report.allWarnings.push(...report.structure.warnings);

  // Validate nodes (if structure is valid enough)
  if (workflow?.nodes) {
    report.nodes = validateNodes(workflow.nodes);
    report.allErrors.push(...report.nodes.errors);
    report.allWarnings.push(...report.nodes.warnings);
  }

  // Validate connections
  if (workflow?.connections && workflow?.nodes) {
    report.connections = validateConnections(workflow.connections, workflow.nodes);
    report.allErrors.push(...report.connections.errors);
    report.allWarnings.push(...report.connections.warnings);
  }

  // Validate webhooks
  if (workflow?.nodes) {
    report.webhooks = validateWebhooks(workflow.nodes);
    report.allErrors.push(...report.webhooks.errors);
    report.allWarnings.push(...report.webhooks.warnings);
  }

  // Calculate overall validity and score
  report.overall.valid = report.allErrors.length === 0;
  const totalIssues = report.allErrors.length + (report.allWarnings.length * 0.5);
  report.overall.score = Math.max(0, Math.round(100 - (totalIssues * 5)));

  // Generate ASCII graph visualization
  report.graph = generateWorkflowGraph(workflow);

  return report;
}

/**
 * Generates an ASCII representation of the workflow graph
 * @param {Object} workflow - The workflow object
 * @returns {string} ASCII graph visualization
 */
function generateWorkflowGraph(workflow) {
  if (!workflow?.nodes || !workflow?.connections) {
    return 'Unable to generate graph: missing nodes or connections';
  }

  const lines = [];
  lines.push('');
  lines.push('Workflow Graph:');
  lines.push('═'.repeat(60));

  const nodeMap = new Map();
  const triggerTypes = ['n8n-nodes-base.webhook', 'n8n-nodes-base.cron', 'n8n-nodes-base.start'];
  
  // Build node map and identify triggers
  workflow.nodes.forEach(node => {
    nodeMap.set(node.name, {
      ...node,
      isTrigger: triggerTypes.includes(node.type),
      outgoing: [],
      incoming: []
    });
  });

  // Build connection graph
  Object.keys(workflow.connections).forEach(sourceName => {
    const connectionData = workflow.connections[sourceName];
    Object.keys(connectionData).forEach(outputType => {
      const outputs = connectionData[outputType];
      if (Array.isArray(outputs)) {
        outputs.forEach(outputArray => {
          if (Array.isArray(outputArray)) {
            outputArray.forEach(conn => {
              const sourceNode = nodeMap.get(sourceName);
              const targetNode = nodeMap.get(conn.node);
              if (sourceNode && targetNode) {
                sourceNode.outgoing.push(conn.node);
                targetNode.incoming.push(sourceName);
              }
            });
          }
        });
      }
    });
  });

  // Render nodes
  lines.push('');
  lines.push('Nodes:');
  nodeMap.forEach((node, name) => {
    const icon = node.isTrigger ? '⚡' : '●';
    const typeShort = node.type ? node.type.split('.').pop() : 'unknown';
    lines.push(`  ${icon} ${name} [${typeShort}]`);
    
    if (node.outgoing.length > 0) {
      node.outgoing.forEach(target => {
        lines.push(`    └─→ ${target}`);
      });
    }
    
    if (node.incoming.length === 0 && !node.isTrigger) {
      lines.push(`    ⚠️  ORPHANED (no incoming connections)`);
    }
  });

  lines.push('');
  lines.push('Legend: ⚡ = Trigger  ● = Node  └─→ = Connection');
  lines.push('═'.repeat(60));
  lines.push('');

  return lines.join('\n');
}

/**
 * Quick validation - returns true if workflow is valid
 * @param {Object} workflow - The workflow object
 * @returns {boolean} True if valid, false otherwise
 */
function isValid(workflow) {
  const report = generateValidationReport(workflow);
  return report.overall.valid;
}

/**
 * Get validation summary
 * @param {Object} workflow - The workflow object
 * @returns {Object} Summary object with counts
 */
function getValidationSummary(workflow) {
  const report = generateValidationReport(workflow);
  return {
    valid: report.overall.valid,
    score: report.overall.score,
    errors: report.allErrors.length,
    warnings: report.allWarnings.length,
    nodes: report.nodes.stats?.totalNodes || 0,
    webhooks: report.webhooks.stats?.totalWebhooks || 0
  };
}

module.exports = {
  validateWorkflowStructure,
  validateNodes,
  validateConnections,
  validateWebhooks,
  generateValidationReport,
  generateWorkflowGraph,
  isValid,
  getValidationSummary,
  // Export constants for testing
  KNOWN_NODE_TYPES,
  VALID_HTTP_METHODS,
  VALID_RESPONSE_MODES
};
