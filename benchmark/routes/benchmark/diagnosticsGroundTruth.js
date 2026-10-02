/**
 * Benchmark Routes - Diagnostics ground truth management
 * List, create, summary, problematic, gaps, update and delete.
 */

const logger = require('../../config/logger');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { isValidObjectId } = require('../../src/helpers/objectIdValidator');
const { getCoverageStats } = require('../../src/services/benchmark/retroCalibration');
const { requireExactConfirmation } = require('../../src/helpers/exactConfirmation');

function registerGroundTruthRoutes(router) {
    // ============ Ground Truth Management Endpoints ============

    /**
     * GET /api/benchmark/judge/ground-truth
     * Get all ground truth entries
     */
    router.get('/judge/ground-truth', async (req, res) => {
        try {
            const { category, active, limit } = req.query;

            const query = {};
            if (category) query.category = category;
            if (active !== undefined) query.active = active === 'true';

            const entries = await JudgeGroundTruth.find(query)
                .select('-reviewer -source_result_id')
                .sort({ createdAt: -1 })
                .limit(parseInt(limit, 10) || 100);

            const total = await JudgeGroundTruth.countDocuments(query);

            res.json({
                status: 'success',
                data: {
                    entries,
                    total,
                    filters: { category, active, limit }
                }
            });
        } catch (err) {
            logger.error('Failed to fetch ground truth entries', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * POST /api/benchmark/judge/ground-truth
     * Create a new ground truth entry
     */
    router.post('/judge/ground-truth', async (req, res) => {
        try {
            const {
                name,
                prompt,
                response,
                category,
                expected_answer,
                expert_scores,
                expert_rationale,
                difficulty,
                tags
            } = req.body;

            // Validate required fields
            if (!name || !prompt || !response || !category || !expert_scores || !expert_rationale) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Missing required fields: name, prompt, response, category, expert_scores, expert_rationale'
                });
            }

            if (expert_scores.overall === undefined || expert_scores.overall === null) {
                return res.status(400).json({
                    status: 'error',
                    error: 'expert_scores.overall is required'
                });
            }

            const entry = new JudgeGroundTruth({
                name,
                prompt,
                response,
                category,
                expected_answer: expected_answer || null,
                expert_scores: {
                    overall: expert_scores.overall,
                    dimensions: expert_scores.dimensions || {}
                },
                expert_rationale,
                difficulty: difficulty || 5,
                tags: tags || [],
                active: true
            });

            await entry.save();

            res.status(201).json({
                status: 'success',
                data: entry
            });
        } catch (err) {
            if (err.code === 11000) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Ground truth entry with this name already exists'
                });
            }
            logger.error('Failed to create ground truth entry', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * GET /api/benchmark/judge/ground-truth/summary
     * Get accuracy summary across all ground truth entries
     */
    router.get('/judge/ground-truth/summary', async (req, res) => {
        try {
            const summary = await JudgeGroundTruth.getAccuracySummary();

            res.json({
                status: 'success',
                data: summary
            });
        } catch (err) {
            logger.error('Failed to fetch ground truth summary', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * GET /api/benchmark/judge/ground-truth/problematic
     * Get ground truth entries with high deviation
     */
    router.get('/judge/ground-truth/problematic', async (req, res) => {
        try {
            const { threshold, limit } = req.query;

            const entries = await JudgeGroundTruth.find({
                active: true,
                'validation_stats.avg_deviation': {
                    $gte: threshold ? parseFloat(threshold) : 2.0
                }
            })
                .sort({ 'validation_stats.avg_deviation': -1 })
                .limit(limit ? parseInt(limit, 10) : 20);
            const publicEntries = entries.map(entry => {
                const value = typeof entry.toObject === 'function' ? entry.toObject() : { ...entry };
                delete value.reviewer;
                delete value.source_result_id;
                return value;
            });

            res.json({
                status: 'success',
                data: {
                    entries: publicEntries,
                    threshold: threshold || 2.0
                }
            });
        } catch (err) {
            logger.error('Failed to fetch problematic ground truth', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * GET /api/benchmark/judge/ground-truth/gaps
     * Coverage grid: how many ground truth entries per category × difficulty
     */
    router.get('/judge/ground-truth/gaps', async (req, res) => {
        try {
            const coverage = await getCoverageStats();
            const coverageByCell = new Map(coverage.cells.map(cell => [
                `${cell.category}\u0000${Number(cell.difficulty)}`,
                cell
            ]));

            const categories = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
            const difficulties = [1, 2, 3, 4, 5];
            const grid = [];
            let totalEntries = 0;
            let totalAllEntries = 0;
            let retroEntries = 0;
            let emptyCount = 0;
            const targetPerCell = 5;
            let cellsMeetingTarget = 0;
            let hardEntries = 0;
            let hardOccupiedCells = 0;
            let hardCellsMeetingTarget = 0;
            const hardGaps = [];

            // Coverage is measured only from qualified human review lanes
            // returned by getCoverageStats. Raw and retro-calibration rows remain
            // visible as audit context but cannot make a cell occupied or ready.
            for (const cat of categories) {
                for (const diff of difficulties) {
                    const found = coverageByCell.get(`${cat}\u0000${diff}`);
                    const allCount = Number(found?.all_count) || 0;
                    const retro = Number(found?.retro) || 0;
                    const count = Number(found?.count) || 0;
                    totalEntries += count;
                    totalAllEntries += allCount;
                    retroEntries += retro;
                    if (count === 0) emptyCount++;
                    if (count >= targetPerCell) cellsMeetingTarget++;
                    if (diff >= 4) {
                        hardEntries += count;
                        if (count > 0) hardOccupiedCells++;
                        if (count >= targetPerCell) hardCellsMeetingTarget++;
                        else hardGaps.push({
                            category: cat,
                            difficulty: diff,
                            count,
                            needed: targetPerCell - count
                        });
                    }
                    grid.push({ category: cat, difficulty: diff, count, all_count: allCount, retro });
                }
            }

            const totalCells = categories.length * difficulties.length;
            const hardTotalCells = categories.length * 2;

            res.json({
                status: 'success',
                data: {
                    grid,
                    total_entries: totalEntries,
                    total_all_entries: totalAllEntries,
                    retro_entries: retroEntries,
                    total_cells: totalCells,
                    empty_cells: emptyCount,
                    // Compatibility field: this measures merely whether a cell has
                    // at least one human entry. It is not calibration sufficiency.
                    coverage_pct: Math.round(((totalCells - emptyCount) / totalCells) * 100),
                    coverage_basis: 'occupied_cells',
                    target_per_cell: targetPerCell,
                    cells_meeting_target: cellsMeetingTarget,
                    target_coverage_pct: Math.round((cellsMeetingTarget / totalCells) * 100),
                    hard_scope: {
                        levels: [4, 5],
                        total_cells: hardTotalCells,
                        entries: hardEntries,
                        occupied_cells: hardOccupiedCells,
                        empty_cells: hardTotalCells - hardOccupiedCells,
                        cells_meeting_target: hardCellsMeetingTarget,
                        target_coverage_pct: Math.round((hardCellsMeetingTarget / hardTotalCells) * 100),
                        target_per_cell: targetPerCell,
                        ready: hardCellsMeetingTarget === hardTotalCells,
                        gaps: hardGaps
                    }
                }
            });
        } catch (err) {
            logger.error('Failed to compute ground truth gaps', { error: err.message });
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    /**
     * PATCH /api/benchmark/judge/ground-truth/:id
     * Update a ground truth entry (e.g. toggle active status)
     */
    router.patch('/judge/ground-truth/:id', async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidObjectId(id)) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Invalid ground truth ID'
                });
            }

            const allowedFields = ['active', 'expert_scores', 'expert_rationale', 'difficulty', 'tags'];
            const updates = {};
            for (const field of allowedFields) {
                if (req.body[field] !== undefined) updates[field] = req.body[field];
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'No valid fields to update'
                });
            }

            const entry = await JudgeGroundTruth.findByIdAndUpdate(id, { $set: updates }, { new: true });

            if (!entry) {
                return res.status(404).json({
                    status: 'error',
                    error: 'Ground truth entry not found'
                });
            }

            res.json({
                status: 'success',
                data: entry
            });
        } catch (err) {
            logger.error('Failed to update ground truth entry', { error: err.message });
            res.status(err.statusCode || 500).json({
                status: 'error',
                code: err.code,
                error: err.message
            });
        }
    });

    /**
     * DELETE /api/benchmark/judge/ground-truth/:id
     * Delete a ground truth entry
     */
    router.delete('/judge/ground-truth/:id', async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidObjectId(id)) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Invalid ground truth ID'
                });
            }

            const expectedConfirmation = `DELETE GROUND TRUTH ${id}`;
            if (!requireExactConfirmation(req, res, expectedConfirmation)) return;

            const entry = await JudgeGroundTruth.findByIdAndDelete(id);

            if (!entry) {
                return res.status(404).json({
                    status: 'error',
                    error: 'Ground truth entry not found'
                });
            }

            res.json({
                status: 'success',
                message: 'Ground truth entry deleted'
            });
        } catch (err) {
            logger.error('Failed to delete ground truth entry', { error: err.message });
            res.status(err.statusCode || 500).json({
                status: 'error',
                code: err.code,
                error: err.message
            });
        }
    });
}

module.exports = { registerGroundTruthRoutes };
