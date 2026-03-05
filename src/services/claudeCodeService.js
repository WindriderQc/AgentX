/**
 * Claude Code Service
 * Thin bridge to execute prompts via `claude -p` CLI.
 * 
 * Supports:
 * - Single-shot execution (stateless)
 * - Session continuity via --continue / --resume
 * - JSON and streaming output formats
 * - Configurable working directory per call
 */

const { execFile } = require('child_process');
const logger = require('../../config/logger');

const CLAUDE_BIN = process.env.CLAUDE_CODE_BIN || 'claude';
const DEFAULT_CWD = process.env.CLAUDE_CODE_CWD || process.cwd();
const DEFAULT_TIMEOUT = parseInt(process.env.CLAUDE_CODE_TIMEOUT || '120000', 10);

/**
 * Execute a prompt via Claude Code CLI
 * @param {string} prompt - The prompt to send
 * @param {Object} [options]
 * @param {string}  [options.cwd]              - Working directory (default: CLAUDE_CODE_CWD)
 * @param {boolean} [options.continueSession]  - Use --continue to resume last session
 * @param {string}  [options.resumeId]         - Resume a specific session by ID
 * @param {number}  [options.timeout]          - Timeout in ms (default: 120000)
 * @param {string}  [options.model]            - Model override (e.g. 'sonnet', 'opus')
 * @param {string[]} [options.allowedTools]    - Tool allowlist (e.g. ['Bash(git:*)', 'Edit'])
 * @param {string}  [options.outputFormat]     - 'text' | 'json' | 'stream-json' (default: 'json')
 * @param {boolean} [options.skipPermissions]  - Use --dangerously-skip-permissions (default: true)
 * @returns {Promise<{result: any, raw: string, sessionId: string|null, duration: number}>}
 */
function executePrompt(prompt, options = {}) {
  const {
    cwd = DEFAULT_CWD,
    continueSession = false,
    resumeId = null,
    timeout = DEFAULT_TIMEOUT,
    model = null,
    allowedTools = null,
    outputFormat = 'json',
    skipPermissions = true
  } = options;

  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', outputFormat];

    if (skipPermissions) args.push('--dangerously-skip-permissions');
    if (continueSession) args.push('--continue');
    if (resumeId) args.push('--resume', resumeId);
    if (model) args.push('--model', model);
    if (allowedTools?.length) args.push('--allowedTools', ...allowedTools);

    const startTime = Date.now();

    logger.info('Claude Code executing', {
      promptPreview: prompt.substring(0, 100),
      cwd,
      continueSession,
      resumeId: resumeId || null,
      model: model || 'default'
    });

    execFile(CLAUDE_BIN, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const duration = Date.now() - startTime;

      if (err) {
        const isTimeout = err.killed || err.signal === 'SIGTERM';
        logger.error('Claude Code execution failed', {
          error: err.message,
          isTimeout,
          duration,
          stderr: stderr?.substring(0, 500)
        });
        return reject(new Error(isTimeout
          ? `Claude Code timed out after ${timeout}ms`
          : `Claude Code error: ${err.message}`
        ));
      }

      const raw = stdout.trim();
      let result = raw;
      let sessionId = null;

      if (outputFormat === 'json') {
        try {
          const parsed = JSON.parse(raw);
          result = parsed;
          sessionId = parsed.session_id || parsed.sessionId || null;
        } catch {
          logger.warn('Claude Code output was not valid JSON, returning raw text', {
            outputLength: raw.length
          });
        }
      }

      logger.info('Claude Code execution complete', {
        duration,
        outputLength: raw.length,
        sessionId
      });

      resolve({ result, raw, sessionId, duration });
    });
  });
}

/**
 * Check if Claude Code CLI is available
 * @returns {Promise<{available: boolean, version: string|null, bin: string}>}
 */
function checkHealth() {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ available: false, version: null, bin: CLAUDE_BIN, error: err.message });
      } else {
        resolve({ available: true, version: stdout.trim(), bin: CLAUDE_BIN });
      }
    });
  });
}

module.exports = {
  executePrompt,
  checkHealth,
  CLAUDE_BIN,
  DEFAULT_CWD,
  DEFAULT_TIMEOUT
};
