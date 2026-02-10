const fs = require('fs').promises;
const path = require('path');
const util = require('util');
const { execFile, spawn } = require('child_process');
const logger = require('../../config/logger');

const execFilePromise = util.promisify(execFile);

class RagCodebaseSyncService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '../..');
    this.scriptPath = options.scriptPath || path.join(this.projectRoot, 'scripts', 'archive-and-ingest-all.sh');
    this.statusFile = options.statusFile || path.join(this.projectRoot, 'logs', 'rag-codebase-sync.status.json');
    this.logFile = options.logFile || path.join(this.projectRoot, 'logs', 'rag-codebase-sync.log');
  }

  async getStatus() {
    const [lastRun, cronLines, logTail] = await Promise.all([
      this._readJson(this.statusFile),
      this._readCrontab(),
      this._tailLog(30)
    ]);

    const cronMatches = cronLines.filter((line) => line.includes('archive-and-ingest-all.sh'));
    const cronEntries = cronMatches.map((line) => this._parseCronLine(line));
    const state = lastRun?.status || 'never_run';

    return {
      state,
      isRunning: state === 'running',
      lastRun: lastRun || null,
      cron: {
        installed: cronEntries.length > 0,
        entries: cronEntries
      },
      scriptPath: this.scriptPath,
      statusFile: this.statusFile,
      logFile: this.logFile,
      logTail
    };
  }

  async runNow({ dryRun = false, docsOnly = false } = {}) {
    const existing = await this._readJson(this.statusFile);
    if (existing?.status === 'running') {
      const startedAt = Date.parse(existing.startedAt || '');
      const isStale = Number.isFinite(startedAt) && (Date.now() - startedAt) > (6 * 60 * 60 * 1000);

      if (!isStale) {
        return {
          started: false,
          reason: 'already_running',
          current: existing
        };
      }

      logger.warn('Ignoring stale running state for RAG codebase sync', {
        startedAt: existing.startedAt
      });
    }

    await fs.mkdir(path.dirname(this.statusFile), { recursive: true });
    await fs.mkdir(path.dirname(this.logFile), { recursive: true });

    const args = [this.scriptPath, '--json'];
    if (dryRun) args.push('--dry-run');
    if (docsOnly) args.push('--docs-only');

    const child = spawn('bash', args, {
      cwd: this.projectRoot,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        RAG_CODEBASE_SYNC_STATUS_FILE: this.statusFile,
        RAG_CODEBASE_SYNC_LOG_FILE: this.logFile,
        RAG_CODEBASE_SYNC_TRIGGER: 'manual-api'
      }
    });

    child.unref();

    logger.info('Triggered manual RAG codebase sync', {
      pid: child.pid,
      dryRun,
      docsOnly
    });

    return {
      started: true,
      pid: child.pid,
      dryRun,
      docsOnly,
      startedAt: new Date().toISOString()
    };
  }

  async _readJson(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      logger.warn('Failed to parse JSON file', { filePath, error: error.message });
      return null;
    }
  }

  async _readCrontab() {
    try {
      const { stdout } = await execFilePromise('crontab', ['-l'], { maxBuffer: 1024 * 1024 });
      return String(stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
    } catch (error) {
      const text = `${error?.stderr || ''} ${error?.message || ''}`.toLowerCase();
      if (text.includes('no crontab')) return [];
      logger.warn('Failed to read crontab', { error: error.message });
      return [];
    }
  }

  _parseCronLine(line) {
    const parts = String(line || '').trim().split(/\s+/);
    if (parts.length < 6) {
      return { schedule: null, command: line, raw: line };
    }

    return {
      schedule: parts.slice(0, 5).join(' '),
      command: parts.slice(5).join(' '),
      raw: line
    };
  }

  async _tailLog(lines = 30) {
    try {
      const { stdout } = await execFilePromise('tail', ['-n', String(lines), this.logFile], {
        maxBuffer: 1024 * 1024
      });
      return String(stdout || '').trim();
    } catch (error) {
      const text = `${error?.stderr || ''} ${error?.message || ''}`.toLowerCase();
      if (error.code === 'ENOENT' || text.includes('no such file')) return '';
      logger.warn('Failed to tail RAG sync log', { error: error.message });
      return '';
    }
  }
}

let _instance = null;

function getRagCodebaseSyncService() {
  if (!_instance) _instance = new RagCodebaseSyncService();
  return _instance;
}

module.exports = {
  RagCodebaseSyncService,
  getRagCodebaseSyncService
};
