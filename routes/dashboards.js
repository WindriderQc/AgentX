/**
 * Dashboard API Routes
 * 
 * Manage custom dashboards and widget data.
 * 
 * Week 4 Day 4 - Advanced Analytics
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const CustomDashboard = require('../models/CustomDashboard');
const Conversation = require('../models/Conversation');
const PromptConfig = require('../models/PromptConfig');
const Alert = require('../models/Alert');
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');
const { attachWorkspace, requireWorkspaceAccess } = require('../src/middleware/workspace');

// Middleware: Authenticate & Attach Workspace
router.use(requireAuth);
router.use(attachWorkspace);
router.use(requireWorkspaceAccess);

// helper for widget data execution
const executeWidgetQuery = async (widget, workspaceId) => {
    const { dataSource } = widget;
    if (!dataSource) return null;

    const collectionMap = {
        'conversations': Conversation,
        'prompts': PromptConfig,
        'alerts': Alert
    };

    const Model = collectionMap[dataSource.collection];
    if (!Model) return { error: 'Invalid collection' };

    const matchStage = { 
        workspaceId,
        ...dataSource.filter 
    };

    // Metric (Single Value)
    if (widget.type === 'metric') {
        if (dataSource.aggregation === 'count') {
            const count = await Model.countDocuments(matchStage);
            return { value: count };
        }
        // TODO: Implement sum/avg
        return { value: 0 };
    }

    // Chart (Grouped Data)
    if (widget.type === 'chart') {
        const pipeline = [
            { $match: matchStage }
        ];

        if (dataSource.groupBy) {
            // Group by date (assumed for now if groupBy is date-like) or field
            // Simplified for MVP: Group by field value or Day
            if (dataSource.groupBy === 'createdAt') {
                pipeline.push({
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                        count: { $sum: 1 }
                    }
                });
                pipeline.push({ $sort: { _id: 1 } }); // Sort by date
            } else {
                pipeline.push({
                    $group: {
                        _id: `$${dataSource.groupBy}`,
                        count: { $sum: 1 }
                    }
                });
            }
        }

        const results = await Model.aggregate(pipeline);
        
        // Format for Chart.js
        return {
            labels: results.map(r => r._id),
            datasets: [{
                label: widget.title || 'Count',
                data: results.map(r => r.count)
            }]
        };
    }

    // Table Widget
    if (widget.type === 'table') {
        let results;
        if (dataSource.pipeline && Array.isArray(dataSource.pipeline) && dataSource.pipeline.length > 0) {
            // Use custom pipeline but ENFORCE workspace scope
            const enforcedMatch = { $match: { workspaceId } };
            // Prepend security enforcement
            results = await Model.aggregate([enforcedMatch, ...dataSource.pipeline]);
        } else {
            // Default: List items with limit
            const fields = dataSource.field ? { [dataSource.field]: 1 } : {};
            // If specific fields aren't requested, maybe don't project?
            // Or default to some reasonable fields?
            // For now, return raw documents (excluding sensitive fields if any)
            results = await Model.find(matchStage).limit(100).lean();
        }

        if (!results || results.length === 0) {
            return { columns: [], rows: [], total: 0 };
        }

        // Extract columns from first result
        // Flatten object? For now, top level keys
        const columns = Object.keys(results[0]).filter(k => k !== '__v' && k !== 'workspaceId');
        
        // Format rows
        const rows = results.map(doc => {
            return columns.map(col => {
                const val = doc[col];
                if (val && typeof val === 'object' && !Array.isArray(val) && val instanceof Date) {
                    return val.toISOString();
                }
                if (val && typeof val === 'object') return JSON.stringify(val);
                return val;
            });
        });

        return {
            columns,
            rows,
            total: results.length
        };
    }

    return null;
};

// ============================================
// CRUD OPERATIONS
// ============================================

/**
 * GET /api/dashboards
 * List dashboards for current workspace
 */
router.get('/', async (req, res) => {
    try {
        const dashboards = await CustomDashboard.find({
            workspaceId: req.workspace._id,
            $or: [
                { createdBy: req.user._id },
                { isPublic: true }
            ]
        }).sort({ updatedAt: -1 });

        res.json({ status: 'success', data: dashboards });
    } catch (error) {
        logger.error('Failed to list dashboards', { error: error.message });
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

/**
 * POST /api/dashboards
 * Create new dashboard
 */
router.post('/', async (req, res) => {
    try {
        const { name, description, layout, isPublic } = req.body;

        const dashboard = await CustomDashboard.create({
            workspaceId: req.workspace._id,
            createdBy: req.user._id,
            name,
            description,
            layout: layout || [],
            isPublic: !!isPublic
        });

        res.status(201).json({ status: 'success', data: dashboard });
    } catch (error) {
        logger.error('Failed to create dashboard', { error: error.message });
        res.status(500).json({ status: 'error', message: 'Failed to create dashboard' });
    }
});

/**
 * GET /api/dashboards/:id
 * Get dashboard details
 */
router.get('/:id', async (req, res) => {
    try {
        const dashboard = await CustomDashboard.findOne({
            _id: req.params.id,
            workspaceId: req.workspace._id
        });

        if (!dashboard) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found' });
        }

        // Check access
        if (!dashboard.isPublic && dashboard.createdBy.toString() !== req.user._id.toString()) {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }

        res.json({ status: 'success', data: dashboard });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

/**
 * PATCH /api/dashboards/:id
 * Update dashboard
 */
router.patch('/:id', async (req, res) => {
    try {
        const { name, description, layout, isPublic } = req.body;
        
        const dashboard = await CustomDashboard.findOne({
            _id: req.params.id,
            workspaceId: req.workspace._id,
            createdBy: req.user._id // Only creator can edit
        });

        if (!dashboard) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found or access denied' });
        }

        if (name) dashboard.name = name;
        if (description !== undefined) dashboard.description = description;
        if (layout) dashboard.layout = layout;
        if (isPublic !== undefined) dashboard.isPublic = isPublic;

        await dashboard.save();

        res.json({ status: 'success', data: dashboard });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

/**
 * DELETE /api/dashboards/:id
 * Delete dashboard
 */
router.delete('/:id', async (req, res) => {
    try {
        const result = await CustomDashboard.deleteOne({
            _id: req.params.id,
            workspaceId: req.workspace._id,
            createdBy: req.user._id
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found or access denied' });
        }

        res.json({ status: 'success', message: 'Dashboard deleted' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

/**
 * POST /api/dashboards/:id/refresh
 * Execute queries for all widgets in the dashboard and return data
 */
router.post('/:id/refresh', async (req, res) => {
    try {
        const dashboard = await CustomDashboard.findOne({
            _id: req.params.id,
            workspaceId: req.workspace._id
        });

        if (!dashboard) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found' });
        }

        const widgetResults = {};
        
        // Execute queries for each widget in parallel
        await Promise.all(dashboard.layout.map(async (widget) => {
            try {
                widgetResults[widget.id] = await executeWidgetQuery(widget, req.workspace._id);
            } catch (err) {
                logger.warn(`Widget query failed for ${widget.id}`, { error: err.message });
                widgetResults[widget.id] = { error: 'Failed to load data' };
            }
        }));

        res.json({ status: 'success', data: widgetResults });
    } catch (error) {
        logger.error('Dashboard refresh failed', { error: error.message });
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

module.exports = router;
