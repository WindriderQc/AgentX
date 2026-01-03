const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../config/logger');

// Path to DataAPI backup scripts
const DATAAPI_SCRIPTS = '/home/yb/codes/DataAPI/scripts';
const BACKUP_DIR = '/mnt/backups'; // Default backup directory

/**
 * Execute shell command with promise
 */
function executeCommand(command, description) {
    return new Promise((resolve, reject) => {
        logger.info(`Executing: ${description}`);
        exec(command, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                logger.error(`Command failed: ${description}`, { error: error.message, stderr });
                reject(new Error(stderr || error.message));
            } else {
                logger.info(`Command completed: ${description}`);
                resolve({ stdout, stderr });
            }
        });
    });
}

/**
 * Get list of backup files from directory
 */
async function listBackupFiles(directory, pattern) {
    try {
        const files = await fs.readdir(directory);
        const backups = [];

        for (const file of files) {
            if (pattern && !file.match(pattern)) continue;

            const filePath = path.join(directory, file);
            const stats = await fs.stat(filePath);

            backups.push({
                name: file,
                size: stats.size,
                date: stats.mtime,
                path: filePath
            });
        }

        return backups.sort((a, b) => b.date - a.date);
    } catch (error) {
        logger.error('Failed to list backup files', { error: error.message, directory });
        return [];
    }
}

function resolveBackupPath(backupType, inputPathOrName) {
    const baseDir = path.join(BACKUP_DIR, backupType);
    if (!inputPathOrName) return null;

    if (path.isAbsolute(inputPathOrName)) {
        return inputPathOrName;
    }

    return path.join(baseDir, path.basename(inputPathOrName));
}

// MongoDB Backup Routes

router.post('/mongodb', async (req, res) => {
    try {
        const script = path.join(DATAAPI_SCRIPTS, 'backup-mongodb.sh');
        const result = await executeCommand(script, 'MongoDB backup');

        res.json({
            success: true,
            message: 'MongoDB backup completed',
            output: result.stdout,
            backup: {
                date: new Date(),
                size: null // Would need to parse output for size
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'MongoDB backup failed',
            error: error.message
        });
    }
});

router.get('/mongodb/list', async (req, res) => {
    try {
        const mongoBackupDir = path.join(BACKUP_DIR, 'mongodb');
        const backups = await listBackupFiles(mongoBackupDir, /agentx_.*\.tar\.gz$/);

        res.json({
            success: true,
            backups
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to list MongoDB backups',
            error: error.message
        });
    }
});

router.post('/mongodb/restore', async (req, res) => {
    try {
        const { filename } = req.body;

        if (!filename) {
            return res.status(400).json({
                success: false,
                message: 'Filename is required'
            });
        }

        const script = path.join(DATAAPI_SCRIPTS, 'restore-mongodb.sh');
        const backupPath = resolveBackupPath('mongodb', filename);
        const result = await executeCommand(`${script} ${backupPath}`, 'MongoDB restore');

        res.json({
            success: true,
            message: 'MongoDB restored successfully',
            output: result.stdout
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'MongoDB restore failed',
            error: error.message
        });
    }
});

router.post('/mongodb/delete', async (req, res) => {
    try {
        const { filename } = req.body;

        if (!filename) {
            return res.status(400).json({
                success: false,
                message: 'Filename is required'
            });
        }

    const filePath = resolveBackupPath('mongodb', filename);
        await fs.unlink(filePath);

        res.json({
            success: true,
            message: 'Backup deleted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to delete backup',
            error: error.message
        });
    }
});

// Qdrant Backup Routes

router.post('/qdrant', async (req, res) => {
    try {
        const script = path.join(DATAAPI_SCRIPTS, 'backup-qdrant.sh');
        const result = await executeCommand(script, 'Qdrant snapshot');

        res.json({
            success: true,
            message: 'Qdrant snapshot completed',
            output: result.stdout,
            backup: {
                date: new Date(),
                size: null
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Qdrant snapshot failed',
            error: error.message
        });
    }
});

router.get('/qdrant/list', async (req, res) => {
    try {
        const qdrantBackupDir = path.join(BACKUP_DIR, 'qdrant');

        // DataAPI's backup-qdrant.sh produces `${COLLECTION}_${DATE}.snapshot` files.
        // Support both `.snapshot` (current) and legacy `.tar.gz` (if ever added).
        const backups = await listBackupFiles(qdrantBackupDir, /(\.snapshot|\.tar\.gz)$/);

        res.json({
            success: true,
            backups
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to list Qdrant snapshots',
            error: error.message
        });
    }
});

router.post('/qdrant/restore', async (req, res) => {
    try {
        const { filename } = req.body;

        if (!filename) {
            return res.status(400).json({
                success: false,
                message: 'Filename is required'
            });
        }

        const script = path.join(DATAAPI_SCRIPTS, 'restore-qdrant.sh');
        const backupPath = resolveBackupPath('qdrant', filename);
        const result = await executeCommand(`${script} ${backupPath}`, 'Qdrant restore');

        res.json({
            success: true,
            message: 'Qdrant restored successfully',
            output: result.stdout
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Qdrant restore failed',
            error: error.message
        });
    }
});

router.post('/qdrant/delete', async (req, res) => {
    try {
        const { filename } = req.body;

        if (!filename) {
            return res.status(400).json({
                success: false,
                message: 'Filename is required'
            });
        }

    const filePath = resolveBackupPath('qdrant', filename);
        await fs.unlink(filePath);

        res.json({
            success: true,
            message: 'Snapshot deleted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to delete snapshot',
            error: error.message
        });
    }
});

// Workflow Version Control Routes

router.post('/workflows/commit', async (req, res) => {
    try {
        const workflowDir = path.join(__dirname, '..', 'AgentC');
        const command = `cd ${workflowDir} && git add *.json && git commit -m "backup: automated workflow backup $(date +%Y-%m-%d_%H:%M:%S)" && git push origin main`;

        const result = await executeCommand(command, 'Workflow commit');

        res.json({
            success: true,
            message: 'Workflows committed successfully',
            output: result.stdout,
            lastCommit: new Date(),
            changes: 0
        });
    } catch (error) {
        // Check if error is "nothing to commit"
        if (error.message.includes('nothing to commit')) {
            return res.json({
                success: true,
                message: 'No changes to commit',
                changes: 0
            });
        }

        res.status(500).json({
            success: false,
            message: 'Workflow commit failed',
            error: error.message
        });
    }
});

router.get('/workflows/history', async (req, res) => {
    try {
        const workflowDir = path.join(__dirname, '..', 'AgentC');
        const command = `cd ${workflowDir} && git log --oneline --all --since="30 days ago" -20`;

        const result = await executeCommand(command, 'Workflow history');

        // Parse git log output
        const commits = result.stdout.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [hash, ...messageParts] = line.split(' ');
                return {
                    hash: hash.trim(),
                    message: messageParts.join(' '),
                    date: new Date() // Would need more complex parsing for actual dates
                };
            });

        res.json({
            success: true,
            commits
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to load workflow history',
            error: error.message
        });
    }
});

router.get('/workflows/diff/:hash', async (req, res) => {
    try {
        const { hash } = req.params;
        const workflowDir = path.join(__dirname, '..', 'AgentC');
        const command = `cd ${workflowDir} && git show ${hash}`;

        const result = await executeCommand(command, 'Workflow diff');

        res.json({
            success: true,
            diff: result.stdout
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to load diff',
            error: error.message
        });
    }
});

// Cron Automation Routes

router.post('/cron/install', async (req, res) => {
    try {
        const script = path.join(DATAAPI_SCRIPTS, 'setup-backup-cron.sh');
        const result = await executeCommand(script, 'Cron installation');

        res.json({
            success: true,
            message: 'Cron jobs installed successfully',
            output: result.stdout
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Cron installation failed',
            error: error.message
        });
    }
});

router.get('/cron/status', async (req, res) => {
    try {
        const result = await executeCommand('crontab -l', 'Check cron status');

        const hasAgentXCron = result.stdout.includes('AgentX Automated Backups') ||
                              result.stdout.includes('agentx-backup');

        res.json({
            success: true,
            status: {
                installed: hasAgentXCron,
                nextBackup: hasAgentXCron ? calculateNextBackup() : null
            },
            cronJobs: result.stdout
        });
    } catch (error) {
        // If crontab is empty, it returns error
        res.json({
            success: true,
            status: {
                installed: false,
                nextBackup: null
            },
            cronJobs: ''
        });
    }
});

router.post('/cron/remove', async (req, res) => {
    try {
        // Remove AgentX cron entries
        const command = `crontab -l | grep -v "AgentX" | grep -v "agentx-backup" | crontab -`;
        const result = await executeCommand(command, 'Remove cron jobs');

        res.json({
            success: true,
            message: 'Cron jobs removed successfully',
            output: result.stdout
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to remove cron jobs',
            error: error.message
        });
    }
});

// Backup Stats Route

router.get('/stats', async (req, res) => {
    try {
        const mongoDir = path.join(BACKUP_DIR, 'mongodb');
        const qdrantDir = path.join(BACKUP_DIR, 'qdrant');

        const mongoBackups = await listBackupFiles(mongoDir, /agentx_.*\.tar\.gz$/);
        const qdrantBackups = await listBackupFiles(qdrantDir, /(\.snapshot|\.tar\.gz)$/);

        // Get workflow stats
        const workflowDir = path.join(__dirname, '..', 'AgentC');
        let workflowStats = { lastCommit: null, uncommitted: 0 };

        try {
            const lastCommitResult = await executeCommand(
                `cd ${workflowDir} && git log -1 --format=%cd`,
                'Get last commit'
            );
            workflowStats.lastCommit = lastCommitResult.stdout.trim();

            const statusResult = await executeCommand(
                `cd ${workflowDir} && git status --porcelain`,
                'Get workflow changes'
            );
            workflowStats.uncommitted = statusResult.stdout.split('\n').filter(l => l.trim()).length;
        } catch (err) {
            logger.warn('Failed to get workflow stats', { error: err.message });
        }

        res.json({
            success: true,
            mongo: {
                count: mongoBackups.length,
                lastBackup: mongoBackups[0]?.date || null,
                totalSize: mongoBackups.reduce((sum, b) => sum + b.size, 0)
            },
            qdrant: {
                count: qdrantBackups.length,
                lastBackup: qdrantBackups[0]?.date || null,
                totalSize: qdrantBackups.reduce((sum, b) => sum + b.size, 0)
            },
            workflows: workflowStats
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to load stats',
            error: error.message
        });
    }
});

// Helper function to calculate next backup time
function calculateNextBackup() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(2, 0, 0, 0); // 2 AM next day
    return tomorrow;
}

module.exports = router;
