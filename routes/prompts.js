/**
 * Prompt Management Routes
 * CRUD operations for prompts with A/B testing support
 */

const express = require('express');
const router = express.Router();
const PromptConfig = require('../models/PromptConfig');
const { requireAuth } = require('../src/middleware/auth');
const logger = require('../config/logger');

/**
 * GET /api/prompts
 * List all prompts (grouped by name)
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const prompts = await PromptConfig.find().sort({ name: 1, version: -1 });
        
        // Group by name
        const grouped = {};
        prompts.forEach(p => {
            if (!grouped[p.name]) grouped[p.name] = [];
            grouped[p.name].push({
                _id: p._id,
                version: p.version,
                isActive: p.isActive,
                trafficWeight: p.trafficWeight,
                description: p.description,
                stats: p.stats,
                createdAt: p.createdAt,
                updatedAt: p.updatedAt
            });
        });
        
        res.json({
            status: 'success',
            data: grouped
        });
    } catch (err) {
        logger.error('List prompts error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/prompts/:name
 * Get all versions of a prompt
 */
router.get('/:name', requireAuth, async (req, res) => {
    try {
        const prompts = await PromptConfig.getVersions(req.params.name);
        
        if (prompts.length === 0) {
            return res.status(404).json({ status: 'error', message: 'Prompt not found' });
        }
        
        res.json({
            status: 'success',
            data: prompts
        });
    } catch (err) {
        logger.error('Get prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/prompts
 * Create a new prompt or new version
 * Body: { name, systemPrompt, description?, isActive?, trafficWeight? }
 */
router.post('/', requireAuth, async (req, res) => {
    const { name, systemPrompt, description, isActive = false, trafficWeight = 100 } = req.body;
    
    if (!name || !systemPrompt) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'name and systemPrompt are required' 
        });
    }
    
    try {
        // Find highest version for this name
        const existing = await PromptConfig.findOne({ name }).sort({ version: -1 });
        const newVersion = existing ? existing.version + 1 : 1;
        
        const prompt = new PromptConfig({
            name,
            systemPrompt,
            description: description || `${name} v${newVersion}`,
            version: newVersion,
            isActive,
            trafficWeight
        });
        
        await prompt.save();
        
        logger.info('Prompt created', { name, version: newVersion });
        
        res.status(201).json({
            status: 'success',
            data: prompt
        });
    } catch (err) {
        logger.error('Create prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * PUT /api/prompts/:id
 * Update a prompt (not the systemPrompt - create new version for that)
 * Body: { isActive?, trafficWeight?, description? }
 */
router.put('/:id', requireAuth, async (req, res) => {
    const { isActive, trafficWeight, description } = req.body;
    
    try {
        const prompt = await PromptConfig.findById(req.params.id);
        
        if (!prompt) {
            return res.status(404).json({ status: 'error', message: 'Prompt not found' });
        }
        
        if (typeof isActive === 'boolean') prompt.isActive = isActive;
        if (typeof trafficWeight === 'number') prompt.trafficWeight = trafficWeight;
        if (description) prompt.description = description;
        
        await prompt.save();
        
        logger.info('Prompt updated', { name: prompt.name, version: prompt.version });
        
        res.json({
            status: 'success',
            data: prompt
        });
    } catch (err) {
        logger.error('Update prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/prompts/:name/ab-test
 * Configure A/B test between versions
 * Body: { versions: [{ version: number, weight: number }] }
 */
router.post('/:name/ab-test', requireAuth, async (req, res) => {
    const { versions } = req.body;
    
    if (!versions || !Array.isArray(versions)) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'versions array is required' 
        });
    }
    
    const totalWeight = versions.reduce((sum, v) => sum + (v.weight || 0), 0);
    if (totalWeight !== 100) {
        return res.status(400).json({ 
            status: 'error', 
            message: `Weights must sum to 100 (got ${totalWeight})` 
        });
    }
    
    try {
        const abTestGroup = `ab_${req.params.name}_${Date.now()}`;
        
        // First, deactivate all versions
        await PromptConfig.updateMany(
            { name: req.params.name },
            { isActive: false, abTestGroup: null, trafficWeight: 0 }
        );
        
        // Then activate and set weights for specified versions
        for (const v of versions) {
            await PromptConfig.findOneAndUpdate(
                { name: req.params.name, version: v.version },
                { isActive: true, trafficWeight: v.weight, abTestGroup }
            );
        }
        
        const updated = await PromptConfig.getVersions(req.params.name);
        
        logger.info('A/B test configured', { name: req.params.name, versions, abTestGroup });
        
        res.json({
            status: 'success',
            message: 'A/B test configured',
            data: {
                abTestGroup,
                versions: updated.filter(p => p.isActive)
            }
        });
    } catch (err) {
        logger.error('A/B test config error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * DELETE /api/prompts/:id
 * Delete a prompt version (only if not active)
 */
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const prompt = await PromptConfig.findById(req.params.id);
        
        if (!prompt) {
            return res.status(404).json({ status: 'error', message: 'Prompt not found' });
        }
        
        if (prompt.isActive) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'Cannot delete active prompt. Deactivate first.' 
            });
        }
        
        await prompt.deleteOne();
        
        logger.info('Prompt deleted', { name: prompt.name, version: prompt.version });
        
        res.json({
            status: 'success',
            message: 'Prompt deleted'
        });
    } catch (err) {
        logger.error('Delete prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/prompts/render
 * Render a prompt template with variables
 * Supports Handlebars-like syntax: {{variable}}, {{#if condition}}...{{/if}}, {{#each items}}...{{/each}}
 */
router.post('/render', requireAuth, async (req, res) => {
    const { name, version, variables } = req.body;

    if (!name) {
        return res.status(400).json({ status: 'error', message: 'Prompt name required' });
    }

    try {
        // Find the prompt (specific version or active version)
        let prompt;
        if (version) {
            prompt = await PromptConfig.findOne({ name, version });
        } else {
            prompt = await PromptConfig.findOne({ name, isActive: true });
        }

        if (!prompt) {
            return res.status(404).json({ status: 'error', message: 'Prompt not found' });
        }

        // Render the template
        const rendered = renderTemplate(prompt.systemPrompt, variables || {});

        // Update usage stats
        prompt.stats.usageCount++;
        await prompt.save();

        logger.info('Prompt rendered', { name: prompt.name, version: prompt.version });

        res.json({
            status: 'success',
            data: {
                name: prompt.name,
                version: prompt.version,
                rendered,
                variables_used: variables || {}
            }
        });
    } catch (err) {
        logger.error('Render prompt error', { error: err.message });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * Simple template renderer with Handlebars-like syntax
 * Supports: {{variable}}, {{#if var}}...{{/if}}, {{#each items}}...{{/each}}
 */
function renderTemplate(template, variables) {
    let rendered = template;

    // Handle {{#if condition}}...{{/if}}
    rendered = rendered.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, varName, content) => {
        const value = variables[varName];
        return value ? content : '';
    });

    // Handle {{#each items}}...{{/each}}
    rendered = rendered.replace(/\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, varName, content) => {
        const items = variables[varName];
        if (!Array.isArray(items)) return '';

        return items.map((item, index) => {
            let itemContent = content;
            // Support {{this}} for simple arrays
            itemContent = itemContent.replace(/\{\{this\}\}/g, String(item));
            // Support {{@index}}
            itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index));
            // Support object properties {{property}}
            if (typeof item === 'object') {
                Object.keys(item).forEach(key => {
                    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
                    itemContent = itemContent.replace(regex, String(item[key]));
                });
            }
            return itemContent;
        }).join('');
    });

    // Handle simple {{variable}} substitution
    rendered = rendered.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
        return variables.hasOwnProperty(varName) ? String(variables[varName]) : match;
    });

    return rendered;
}

module.exports = router;
