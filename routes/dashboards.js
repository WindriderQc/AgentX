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
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');
const { attachWorkspace, requireWorkspaceAccess, requireAdmin } = require('../src/middleware/workspace');
const {
    executeWidgetQuery,
    validateDashboardLayout,
    validateWidgetDefinition
} = require('../src/services/dashboardService');

// Middleware: Authenticate & Attach Workspace
router.use(requireAuth);
router.use(attachWorkspace);
router.use(requireWorkspaceAccess);

// SECURITY: Middleware to validate ObjectId parameters
function validateObjectIdParam(paramName = 'id') {
    return (req, res, next) => {
        const id = req.params[paramName];
        if (id && !mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                status: 'error',
                message: `Invalid ${paramName} format`
            });
        }
        next();
    };
}

const canEditDashboard = (req, dashboard) => {
    if (!dashboard || !req.user) return false;
    if (dashboard.createdBy.toString() === req.user._id.toString()) return true;
    return req.workspaceMember?.isAdmin?.() === true;
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
router.post('/', requireAdmin, async (req, res) => {
    try {
        const { name, description, layout, isPublic } = req.body;

        const validation = validateDashboardLayout(layout || []);
        if (!validation.isValid) {
            return res.status(400).json({
                status: 'error',
                message: validation.errors.join(' ')
            });
        }

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
router.get('/:id', validateObjectIdParam('id'), async (req, res) => {
    try {
        // SECURITY: Cast to ObjectId to prevent NoSQL injection
        const dashboard = await CustomDashboard.findOne({
            _id: mongoose.Types.ObjectId(req.params.id),
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
            _id: mongoose.Types.ObjectId(req.params.id),
            workspaceId: req.workspace._id
        });

        if (!dashboard) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found' });
        }

        if (!canEditDashboard(req, dashboard)) {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }

        if (layout) {
            const validation = validateDashboardLayout(layout);
            if (!validation.isValid) {
                return res.status(400).json({
                    status: 'error',
                    message: validation.errors.join(' ')
                });
            }
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
 * POST /api/dashboards/:id/panels
 * Add a panel to a dashboard
 */
router.post('/:id/panels', async (req, res) => {
    try {
        const dashboard = await CustomDashboard.findOne({
            _id: mongoose.Types.ObjectId(req.params.id),
            workspaceId: req.workspace._id
        });

        if (!dashboard) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found' });
        }

        if (!canEditDashboard(req, dashboard)) {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }

        const panelInput = req.body || {};
        const panel = {
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            ...panelInput,
            id: panelInput.id || `panel_${new mongoose.Types.ObjectId().toString()}`
        };

        const validation = validateWidgetDefinition(panel);
        if (!validation.isValid) {
            return res.status(400).json({ status: 'error', message: validation.errors.join(' ') });
        }

        dashboard.layout.push(panel);
        await dashboard.save();

        res.status(201).json({ status: 'success', data: dashboard });
    } catch (error) {
        logger.error('Failed to add dashboard panel', { error: error.message });
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

/**
 * PATCH /api/dashboards/:id/panels/:panelId
 * Update a panel in a dashboard
 */
router.patch('/:id/panels/:panelId', async (req, res) => {
    try {
        const dashboard = await CustomDashboard.findOne({
            _id: mongoose.Types.ObjectId(req.params.id),
            workspaceId: req.workspace._id
        });

        if (!dashboard) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found' });
        }

        if (!canEditDashboard(req, dashboard)) {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }

        const panelIndex = dashboard.layout.findIndex(panel => panel.id === req.params.panelId);
        if (panelIndex === -1) {
            return res.status(404).json({ status: 'error', message: 'Panel not found' });
        }

        const existingPanel = dashboard.layout[panelIndex].toObject
            ? dashboard.layout[panelIndex].toObject()
            : dashboard.layout[panelIndex];

        const updatedPanel = {
            ...existingPanel,
            ...req.body,
            dataSource: {
                ...existingPanel.dataSource,
                ...(req.body?.dataSource || {})
            },
            id: existingPanel.id
        };

        const validation = validateWidgetDefinition(updatedPanel);
        if (!validation.isValid) {
            return res.status(400).json({ status: 'error', message: validation.errors.join(' ') });
        }

        dashboard.layout[panelIndex] = updatedPanel;
        await dashboard.save();

        res.json({ status: 'success', data: dashboard });
    } catch (error) {
        logger.error('Failed to update dashboard panel', { error: error.message });
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

/**
 * DELETE /api/dashboards/:id/panels/:panelId
 * Remove a panel from a dashboard
 */
router.delete('/:id/panels/:panelId', async (req, res) => {
    try {
        const dashboard = await CustomDashboard.findOne({
            _id: mongoose.Types.ObjectId(req.params.id),
            workspaceId: req.workspace._id
        });

        if (!dashboard) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found' });
        }

        if (!canEditDashboard(req, dashboard)) {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }

        const originalLength = dashboard.layout.length;
        dashboard.layout = dashboard.layout.filter(panel => panel.id !== req.params.panelId);

        if (dashboard.layout.length === originalLength) {
            return res.status(404).json({ status: 'error', message: 'Panel not found' });
        }

        await dashboard.save();
        res.json({ status: 'success', data: dashboard });
    } catch (error) {
        logger.error('Failed to delete dashboard panel', { error: error.message });
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

/**
 * DELETE /api/dashboards/:id
 * Delete dashboard
 */
router.delete('/:id', async (req, res) => {
    try {
        const dashboard = await CustomDashboard.findOne({
            _id: mongoose.Types.ObjectId(req.params.id),
            workspaceId: req.workspace._id
        });

        if (!dashboard) {
            return res.status(404).json({ status: 'error', message: 'Dashboard not found' });
        }

        if (!canEditDashboard(req, dashboard)) {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }

        await dashboard.deleteOne();
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
            _id: mongoose.Types.ObjectId(req.params.id),
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
