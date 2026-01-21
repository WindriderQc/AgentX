const express = require('express');
const router = express.Router();
const { exec, execFile } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../config/logger');
const os = require('os');

const execFilePromise = util.promisify(execFile);

// Path to AgentX ops scripts
const AGENTX_SCRIPTS = path.join(__dirname, '..', 'scripts');
// Use home directory for backups by default (more reliable than /mnt)
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), 'backups');
const BACKUP_DIR = process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR;

// Ensure backup directories exist on module load
(async () => {
    try {
        await fs.mkdir(path.join(BACKUP_DIR, 'mongodb'), { recursive: true });
        await fs.mkdir(path.join(BACKUP_DIR, 'qdrant'), { recursive: true });
        logger.info('Backup directories initialized', { backupDir: BACKUP_DIR });
    } catch (err) {
        logger.error('Failed to create backup directories', { error: err.message, backupDir: BACKUP_DIR });
    }
})();

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
 * Validate git hash to prevent command injection
 */
function validateGitHash(hash) {
    if (!hash || typeof hash !== 'string') {
        throw new Error('Git hash is required');
    }
    // Git hashes are 7-40 character hex strings
    if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
        throw new Error('Invalid git hash format');
    }
    return hash;
}

/**
 * Validate backup filename to prevent path traversal
 */
function validateBackupFilename(filename, backupType) {
    if (!filename || typeof filename !== 'string') {
        throw new Error('Filename is required');
    }

    // Reject path traversal attempts
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new Error('Invalid filename: path traversal detected');
    }

    // Whitelist allowed extensions
    const validExtensions = backupType === 'mongodb'
        ? ['.tar.gz', '.gz']
        : ['.snapshot', '.tar.gz', '.gz'];

    if (!validExtensions.some(ext => filename.endsWith(ext))) {
        throw new Error(`Invalid file extension for ${backupType} backup`);
    }

    // Ensure resolved path is within backup directory
    const baseDir = path.join(BACKUP_DIR, backupType);
    const resolvedPath = path.resolve(baseDir, filename);

    if (!resolvedPath.startsWith(path.resolve(baseDir))) {
        throw new Error('Path traversal detected');
    }

    return resolvedPath;
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
        const script = path.join(AGENTX_SCRIPTS, 'backup-mongodb.sh');
        const mongoBackupDir = path.join(BACKUP_DIR, 'mongodb');
        const result = await executeCommand(`${script} ${mongoBackupDir}`, 'MongoDB backup');

        // Resolve backup metadata from the latest file actually created.
        const backups = await listBackupFiles(mongoBackupDir, /agentx_.*\.tar\.gz$/);
        const latest = backups[0] || null;

        res.json({
            success: true,
            message: 'MongoDB backup completed',
            output: result.stdout,
            backup: {
                date: latest?.date || new Date(),
                size: latest?.size ?? null
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

        const script = path.join(AGENTX_SCRIPTS, 'restore-mongodb.sh');
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

        // SECURITY: Validate filename to prevent path traversal
        const filePath = validateBackupFilename(filename, 'mongodb');
        await fs.unlink(filePath);

        logger.info('MongoDB backup deleted', { filename });
        res.json({
            success: true,
            message: 'Backup deleted successfully'
        });
    } catch (error) {
        logger.error('Failed to delete MongoDB backup', { error: error.message, filename: req.body.filename });
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
        const script = path.join(AGENTX_SCRIPTS, 'backup-qdrant.sh');
        const qdrantBackupDir = path.join(BACKUP_DIR, 'qdrant');
        const result = await executeCommand(`${script} ${qdrantBackupDir}`, 'Qdrant snapshot');

        const backups = await listBackupFiles(qdrantBackupDir, /(\.snapshot|\.tar\.gz)$/);
        const latest = backups[0] || null;

        res.json({
            success: true,
            message: 'Qdrant snapshot completed',
            output: result.stdout,
            backup: {
                date: latest?.date || new Date(),
                size: latest?.size ?? null
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

        const script = path.join(AGENTX_SCRIPTS, 'restore-qdrant.sh');
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

        // SECURITY: Validate filename to prevent path traversal
        const filePath = validateBackupFilename(filename, 'qdrant');
        await fs.unlink(filePath);

        logger.info('Qdrant snapshot deleted', { filename });
        res.json({
            success: true,
            message: 'Snapshot deleted successfully'
        });
    } catch (error) {
        logger.error('Failed to delete Qdrant snapshot', { error: error.message, filename: req.body.filename });
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
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const commitMessage = `backup: automated workflow backup ${timestamp}`;

        // SECURITY: Use execFile with separate commands to prevent injection
        // Step 1: git add
        await execFilePromise('git', ['add', '*.json'], {
            cwd: workflowDir,
            shell: true // Need shell for glob expansion
        });

        // Step 2: git commit
        let commitResult;
        try {
            commitResult = await execFilePromise('git', ['commit', '-m', commitMessage], {
                cwd: workflowDir
            });
        } catch (error) {
            // Check if error is "nothing to commit"
            if (error.message && error.message.includes('nothing to commit')) {
                return res.json({
                    success: true,
                    message: 'No changes to commit',
                    changes: 0
                });
            }
            throw error;
        }

        // Step 3: git push
        const pushResult = await execFilePromise('git', ['push', 'origin', 'main'], {
            cwd: workflowDir
        });

        res.json({
            success: true,
            message: 'Workflows committed successfully',
            output: commitResult.stdout + '\n' + pushResult.stdout,
            lastCommit: new Date(),
            changes: 0
        });
    } catch (error) {
        logger.error('Workflow commit failed', { error: error.message });
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

        // SECURITY: Use execFile with array arguments to prevent injection
        const result = await execFilePromise('git', [
            'log',
            '--oneline',
            '--all',
            '--since=30 days ago',
            '-20'
        ], {
            cwd: workflowDir,
            maxBuffer: 10 * 1024 * 1024
        });

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
        logger.error('Failed to load workflow history', { error: error.message });
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

        // SECURITY: Validate git hash to prevent command injection
        const validatedHash = validateGitHash(hash);

        const workflowDir = path.join(__dirname, '..', 'AgentC');

        // SECURITY: Use execFile instead of exec to prevent command injection
        const result = await execFilePromise('git', ['show', validatedHash], {
            cwd: workflowDir,
            maxBuffer: 10 * 1024 * 1024
        });

        res.json({
            success: true,
            diff: result.stdout
        });
    } catch (error) {
        logger.error('Failed to load diff', { error: error.message, hash: req.params.hash });
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
        const script = path.join(AGENTX_SCRIPTS, 'setup-backup-cron.sh');
        
        // Verify script exists and is executable
        try {
            await fs.access(script, fs.constants.X_OK);
        } catch (accessError) {
            logger.error('Cron script not accessible', { script, error: accessError.message });
            return res.status(500).json({
                success: false,
                message: 'Cron installation script not found or not executable',
                error: `Script: ${script} - ${accessError.message}`
            });
        }
        
        const result = await executeCommand(`bash ${script}`, 'Cron installation');

        res.json({
            success: true,
            message: 'Cron jobs installed successfully',
            output: result.stdout
        });
    } catch (error) {
        logger.error('Cron installation error', { error: error.message, stack: error.stack });
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
                lastSize: mongoBackups[0]?.size ?? null,
                totalSize: mongoBackups.reduce((sum, b) => sum + b.size, 0)
            },
            qdrant: {
                count: qdrantBackups.length,
                lastBackup: qdrantBackups[0]?.date || null,
                lastSize: qdrantBackups[0]?.size ?? null,
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
