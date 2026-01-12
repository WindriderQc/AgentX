/**
 * AgentX Routes
 * CRUD operations for AgentX entities (unified agents with model + prompt + tools)
 */

const express = require('express');
const router = express.Router();
const AgentX = require('../models/AgentX');
const PromptConfig = require('../models/PromptConfig');
const { requireAuth, optionalAuth } = require('../src/middleware/auth');
const { attachWorkspace, optionalWorkspaceContext } = require('../src/middleware/workspace');
const logger = require('../config/logger');
const { validateObjectId } = require('../src/helpers/objectIdValidator');

/**
 * GET /api/agents
 * List all agents (hydrated with prompt data) - workspace-aware
 */
router.get('/', optionalAuth, optionalWorkspaceContext, async (req, res) => {
    try {
        const { category, search, includeInactive } = req.query;
        const query = {};

        // Filter by active status (default: only active)
        if (includeInactive !== 'true') {
            query.isActive = true;
        }

        // Filter by category
        if (category && category !== 'all') {
            query.category = category;
        }

        // Multi-tenancy: Filter by workspace with fallback to global
        if (req.workspace) {
            query.$or = [
                { workspaceId: req.workspace._id },
                { workspaceId: { $exists: false } },
                { workspaceId: null }
            ];
        }

        let agents = await AgentX.find(query)
            .populate('promptConfigId', 'name systemPrompt version isActive description stats')
            .sort({ displayName: 1 });

        // Search filter (applied in memory for flexibility)
        if (search) {
            const searchLower = search.toLowerCase();
            agents = agents.filter(agent =>
                agent.displayName.toLowerCase().includes(searchLower) ||
                agent.description?.toLowerCase().includes(searchLower) ||
                agent.name.toLowerCase().includes(searchLower)
            );
        }

        // Transform for frontend
        const data = agents.map(agent => ({
            _id: agent._id,
            name: agent.name,
            displayName: agent.displayName,
            description: agent.description,
            avatar: agent.avatar,
            category: agent.category,
            tags: agent.tags,
            defaultModel: agent.defaultModel,
            fallbackModels: agent.fallbackModels,
            modelConstraints: agent.modelConstraints,
            capabilities: agent.capabilities,
            n8nToolCount: agent.n8nTools?.filter(t => t.isActive).length || 0,
            n8nTools: agent.n8nTools?.map(t => ({
                toolId: t.toolId,
                name: t.name,
                description: t.description,
                isActive: t.isActive
            })),
            prompt: agent.promptConfigId ? {
                _id: agent.promptConfigId._id,
                name: agent.promptConfigId.name,
                version: agent.promptConfigId.version,
                isActive: agent.promptConfigId.isActive,
                description: agent.promptConfigId.description
            } : null,
            isActive: agent.isActive,
            isDefault: agent.isDefault,
            stats: agent.stats,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt
        }));

        res.json({
            status: 'success',
            data,
            count: data.length
        });
    } catch (err) {
        logger.error('List agents error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/agents/categories
 * Get available categories with counts
 */
router.get('/categories', optionalAuth, optionalWorkspaceContext, async (req, res) => {
    try {
        const query = { isActive: true };

        if (req.workspace) {
            query.$or = [
                { workspaceId: req.workspace._id },
                { workspaceId: { $exists: false } },
                { workspaceId: null }
            ];
        }

        const categories = await AgentX.aggregate([
            { $match: query },
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);

        const categoryConfig = {
            coding: { label: 'Coding', icon: 'fa-code', color: '#10b981' },
            reasoning: { label: 'Reasoning', icon: 'fa-brain', color: '#8b5cf6' },
            factual: { label: 'Factual', icon: 'fa-book', color: '#3b82f6' },
            math: { label: 'Math', icon: 'fa-calculator', color: '#f59e0b' },
            creative: { label: 'Creative', icon: 'fa-palette', color: '#ec4899' },
            general: { label: 'General', icon: 'fa-robot', color: '#6b7280' },
            specialist: { label: 'Specialist', icon: 'fa-star', color: '#eab308' }
        };

        const data = categories.map(cat => ({
            category: cat._id,
            count: cat.count,
            ...categoryConfig[cat._id]
        }));

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Get categories error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/agents/default
 * Get the default agent for the workspace
 */
router.get('/default', optionalAuth, optionalWorkspaceContext, async (req, res) => {
    try {
        const workspaceId = req.workspace?._id || null;
        const agent = await AgentX.getDefault(workspaceId);

        if (!agent) {
            return res.json({
                status: 'success',
                data: null,
                message: 'No default agent configured'
            });
        }

        res.json({
            status: 'success',
            data: agent
        });
    } catch (err) {
        logger.error('Get default agent error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/agents/:id
 * Get a single agent with full details
 */
router.get('/:id', optionalAuth, optionalWorkspaceContext, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Agent ID')) return;

        const agent = await AgentX.getFullAgent(req.params.id);

        if (!agent) {
            return res.status(404).json({ status: 'error', message: 'Agent not found' });
        }

        // Verify workspace access
        if (req.workspace && agent.workspaceId &&
            agent.workspaceId._id?.toString() !== req.workspace._id.toString()) {
            return res.status(403).json({ status: 'error', message: 'Access denied - wrong workspace' });
        }

        res.json({
            status: 'success',
            data: agent
        });
    } catch (err) {
        logger.error('Get agent error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/agents
 * Create a new agent
 * Body: { name, displayName, description?, avatar?, category?, promptConfigId, defaultModel, ... }
 */
router.post('/', optionalAuth, attachWorkspace, async (req, res) => {
    const {
        name,
        displayName,
        description,
        avatar,
        category,
        tags,
        promptConfigId,
        defaultModel,
        fallbackModels,
        modelConstraints,
        n8nTools,
        capabilities,
        isActive,
        isDefault
    } = req.body;

    // Validation
    if (!name || !displayName || !promptConfigId || !defaultModel) {
        return res.status(400).json({
            status: 'error',
            message: 'name, displayName, promptConfigId, and defaultModel are required'
        });
    }

    try {
        // Verify promptConfigId exists
        if (!validateObjectId(promptConfigId, res, 'Prompt Config ID')) return;

        const prompt = await PromptConfig.findById(promptConfigId);
        if (!prompt) {
            return res.status(400).json({
                status: 'error',
                message: 'Referenced prompt configuration not found'
            });
        }

        // Check for duplicate name in workspace
        const existingQuery = { name };
        if (req.workspace) {
            existingQuery.workspaceId = req.workspace._id;
        }
        const existing = await AgentX.findOne(existingQuery);
        if (existing) {
            return res.status(400).json({
                status: 'error',
                message: `Agent with name "${name}" already exists`
            });
        }

        const agent = new AgentX({
            name,
            displayName,
            description: description || '',
            avatar: avatar || 'fa-robot',
            category: category || 'general',
            tags: tags || [],
            promptConfigId,
            defaultModel,
            fallbackModels: fallbackModels || [],
            modelConstraints: modelConstraints || {},
            n8nTools: n8nTools || [],
            capabilities: capabilities || {},
            isActive: isActive !== false,
            isDefault: isDefault || false,
            workspaceId: req.workspace?._id || null,
            createdBy: req.user?._id || null
        });

        await agent.save();

        // If set as default, unset others
        if (agent.isDefault) {
            await AgentX.updateMany(
                {
                    workspaceId: agent.workspaceId,
                    isDefault: true,
                    _id: { $ne: agent._id }
                },
                { $set: { isDefault: false } }
            );
        }

        logger.info('Agent created', { name: agent.name, id: agent._id });

        // Return populated agent
        const populated = await AgentX.getFullAgent(agent._id);

        res.status(201).json({
            status: 'success',
            data: populated
        });
    } catch (err) {
        logger.error('Create agent error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * PUT /api/agents/:id
 * Update an agent
 */
router.put('/:id', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Agent ID')) return;

        const agent = await AgentX.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({ status: 'error', message: 'Agent not found' });
        }

        // Verify workspace access
        if (req.workspace && agent.workspaceId &&
            agent.workspaceId.toString() !== req.workspace._id.toString()) {
            return res.status(403).json({ status: 'error', message: 'Access denied - wrong workspace' });
        }

        const {
            displayName,
            description,
            avatar,
            category,
            tags,
            promptConfigId,
            defaultModel,
            fallbackModels,
            modelConstraints,
            n8nTools,
            capabilities,
            isActive,
            isDefault
        } = req.body;

        // Update fields if provided
        if (displayName !== undefined) agent.displayName = displayName;
        if (description !== undefined) agent.description = description;
        if (avatar !== undefined) agent.avatar = avatar;
        if (category !== undefined) agent.category = category;
        if (tags !== undefined) agent.tags = tags;
        if (defaultModel !== undefined) agent.defaultModel = defaultModel;
        if (fallbackModels !== undefined) agent.fallbackModels = fallbackModels;
        if (modelConstraints !== undefined) agent.modelConstraints = { ...agent.modelConstraints, ...modelConstraints };
        if (n8nTools !== undefined) agent.n8nTools = n8nTools;
        if (capabilities !== undefined) agent.capabilities = { ...agent.capabilities, ...capabilities };
        if (isActive !== undefined) agent.isActive = isActive;

        // Handle promptConfigId update
        if (promptConfigId !== undefined) {
            if (!validateObjectId(promptConfigId, res, 'Prompt Config ID')) return;
            const prompt = await PromptConfig.findById(promptConfigId);
            if (!prompt) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Referenced prompt configuration not found'
                });
            }
            agent.promptConfigId = promptConfigId;
        }

        // Handle isDefault change
        if (isDefault !== undefined && isDefault !== agent.isDefault) {
            if (isDefault) {
                // Unset other defaults in workspace
                await AgentX.updateMany(
                    {
                        workspaceId: agent.workspaceId,
                        isDefault: true,
                        _id: { $ne: agent._id }
                    },
                    { $set: { isDefault: false } }
                );
            }
            agent.isDefault = isDefault;
        }

        await agent.save();

        logger.info('Agent updated', { name: agent.name, id: agent._id });

        // Return populated agent
        const populated = await AgentX.getFullAgent(agent._id);

        res.json({
            status: 'success',
            data: populated
        });
    } catch (err) {
        logger.error('Update agent error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/agents/:id/set-default
 * Set an agent as the default for its workspace
 */
router.post('/:id/set-default', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Agent ID')) return;

        const agent = await AgentX.setDefault(req.params.id);

        logger.info('Agent set as default', { name: agent.name, id: agent._id });

        res.json({
            status: 'success',
            message: `${agent.displayName} is now the default agent`,
            data: agent
        });
    } catch (err) {
        logger.error('Set default agent error', { error: err.message });
        res.status(err.status || 500).json({ status: 'error', message: err.message });
    }
});

/**
 * DELETE /api/agents/:id
 * Soft delete an agent (set isActive = false)
 */
router.delete('/:id', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Agent ID')) return;

        const agent = await AgentX.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({ status: 'error', message: 'Agent not found' });
        }

        // Verify workspace access
        if (req.workspace && agent.workspaceId &&
            agent.workspaceId.toString() !== req.workspace._id.toString()) {
            return res.status(403).json({ status: 'error', message: 'Access denied - wrong workspace' });
        }

        // Check if hard delete is requested
        const { hard } = req.query;

        if (hard === 'true') {
            await agent.deleteOne();
            logger.info('Agent hard deleted', { name: agent.name, id: agent._id });
        } else {
            agent.isActive = false;
            agent.isDefault = false;
            await agent.save();
            logger.info('Agent soft deleted', { name: agent.name, id: agent._id });
        }

        res.json({
            status: 'success',
            message: hard === 'true' ? 'Agent permanently deleted' : 'Agent deactivated'
        });
    } catch (err) {
        logger.error('Delete agent error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================
// N8N Tool Management Routes
// ============================================

/**
 * GET /api/agents/:id/tools
 * List N8N tools for an agent
 */
router.get('/:id/tools', optionalAuth, optionalWorkspaceContext, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Agent ID')) return;

        const agent = await AgentX.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({ status: 'error', message: 'Agent not found' });
        }

        res.json({
            status: 'success',
            data: agent.n8nTools,
            count: agent.n8nTools.length
        });
    } catch (err) {
        logger.error('Get agent tools error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/agents/:id/tools
 * Add an N8N tool to an agent
 * Body: { toolId, name, description, webhookUrl, inputSchema?, timeout? }
 */
router.post('/:id/tools', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Agent ID')) return;

        const agent = await AgentX.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({ status: 'error', message: 'Agent not found' });
        }

        // Verify workspace access
        if (req.workspace && agent.workspaceId &&
            agent.workspaceId.toString() !== req.workspace._id.toString()) {
            return res.status(403).json({ status: 'error', message: 'Access denied - wrong workspace' });
        }

        const { toolId, name, description, webhookUrl, inputSchema, timeout } = req.body;

        if (!toolId || !name || !description || !webhookUrl) {
            return res.status(400).json({
                status: 'error',
                message: 'toolId, name, description, and webhookUrl are required'
            });
        }

        // Check for duplicate toolId
        if (agent.n8nTools.some(t => t.toolId === toolId)) {
            return res.status(400).json({
                status: 'error',
                message: `Tool with ID "${toolId}" already exists on this agent`
            });
        }

        agent.n8nTools.push({
            toolId,
            name,
            description,
            webhookUrl,
            inputSchema: inputSchema || { type: 'object', properties: {}, required: [] },
            timeout: timeout || 30000,
            isActive: true
        });

        await agent.save();

        logger.info('Tool added to agent', { agentId: agent._id, toolId });

        res.status(201).json({
            status: 'success',
            data: agent.n8nTools[agent.n8nTools.length - 1]
        });
    } catch (err) {
        logger.error('Add agent tool error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * PUT /api/agents/:id/tools/:toolId
 * Update an N8N tool on an agent
 */
router.put('/:id/tools/:toolId', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Agent ID')) return;

        const agent = await AgentX.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({ status: 'error', message: 'Agent not found' });
        }

        // Verify workspace access
        if (req.workspace && agent.workspaceId &&
            agent.workspaceId.toString() !== req.workspace._id.toString()) {
            return res.status(403).json({ status: 'error', message: 'Access denied - wrong workspace' });
        }

        const tool = agent.n8nTools.find(t => t.toolId === req.params.toolId);

        if (!tool) {
            return res.status(404).json({ status: 'error', message: 'Tool not found on this agent' });
        }

        const { name, description, webhookUrl, inputSchema, timeout, isActive } = req.body;

        if (name !== undefined) tool.name = name;
        if (description !== undefined) tool.description = description;
        if (webhookUrl !== undefined) tool.webhookUrl = webhookUrl;
        if (inputSchema !== undefined) tool.inputSchema = inputSchema;
        if (timeout !== undefined) tool.timeout = timeout;
        if (isActive !== undefined) tool.isActive = isActive;

        await agent.save();

        logger.info('Tool updated on agent', { agentId: agent._id, toolId: req.params.toolId });

        res.json({
            status: 'success',
            data: tool
        });
    } catch (err) {
        logger.error('Update agent tool error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * DELETE /api/agents/:id/tools/:toolId
 * Remove an N8N tool from an agent
 */
router.delete('/:id/tools/:toolId', optionalAuth, attachWorkspace, async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Agent ID')) return;

        const agent = await AgentX.findById(req.params.id);

        if (!agent) {
            return res.status(404).json({ status: 'error', message: 'Agent not found' });
        }

        // Verify workspace access
        if (req.workspace && agent.workspaceId &&
            agent.workspaceId.toString() !== req.workspace._id.toString()) {
            return res.status(403).json({ status: 'error', message: 'Access denied - wrong workspace' });
        }

        const toolIndex = agent.n8nTools.findIndex(t => t.toolId === req.params.toolId);

        if (toolIndex === -1) {
            return res.status(404).json({ status: 'error', message: 'Tool not found on this agent' });
        }

        agent.n8nTools.splice(toolIndex, 1);
        await agent.save();

        logger.info('Tool removed from agent', { agentId: agent._id, toolId: req.params.toolId });

        res.json({
            status: 'success',
            message: 'Tool removed from agent'
        });
    } catch (err) {
        logger.error('Delete agent tool error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
