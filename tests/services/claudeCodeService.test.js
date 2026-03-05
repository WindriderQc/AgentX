/**
 * Claude Code Service Tests
 * Tests for the claude -p CLI bridge
 */

const { execFile } = require('child_process');

// Mock child_process
jest.mock('child_process', () => ({
  execFile: jest.fn()
}));

// Mock logger
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

const { executePrompt, checkHealth, CLAUDE_BIN, DEFAULT_CWD, DEFAULT_TIMEOUT } = require('../../src/services/claudeCodeService');

describe('Claude Code Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('executePrompt', () => {
    it('should execute claude -p with correct default args', async () => {
      const mockOutput = JSON.stringify({ result: 'done', session_id: 'abc-123' });
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, mockOutput, ''));

      const result = await executePrompt('refactor auth module');

      expect(execFile).toHaveBeenCalledTimes(1);
      const [bin, args, opts] = execFile.mock.calls[0];
      expect(bin).toBe('claude');
      expect(args).toContain('-p');
      expect(args).toContain('refactor auth module');
      expect(args).toContain('--output-format');
      expect(args).toContain('json');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
      expect(result.result).toEqual({ result: 'done', session_id: 'abc-123' });
      expect(result.sessionId).toBe('abc-123');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should add --continue when continueSession is true', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, '{}', ''));

      await executePrompt('test', { continueSession: true });

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--continue');
    });

    it('should add --resume with session ID', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, '{}', ''));

      await executePrompt('test', { resumeId: 'session-xyz' });

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--resume');
      expect(args).toContain('session-xyz');
    });

    it('should add --model when specified', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, '{}', ''));

      await executePrompt('test', { model: 'sonnet' });

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
    });

    it('should not add --dangerously-skip-permissions when skipPermissions is false', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, '{}', ''));

      await executePrompt('test', { skipPermissions: false });

      const args = execFile.mock.calls[0][1];
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('should handle text output format', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'plain text response', ''));

      const result = await executePrompt('test', { outputFormat: 'text' });

      expect(result.result).toBe('plain text response');
      expect(result.raw).toBe('plain text response');
    });

    it('should handle non-JSON output gracefully when json format expected', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, 'not json at all', ''));

      const result = await executePrompt('test');

      // Should not throw, returns raw text
      expect(result.result).toBe('not json at all');
      expect(result.raw).toBe('not json at all');
    });

    it('should reject on execution error', async () => {
      const err = new Error('command not found');
      execFile.mockImplementation((bin, args, opts, cb) => cb(err, '', 'error output'));

      await expect(executePrompt('test')).rejects.toThrow('Claude Code error: command not found');
    });

    it('should detect timeout (SIGTERM)', async () => {
      const err = new Error('killed');
      err.killed = true;
      err.signal = 'SIGTERM';
      execFile.mockImplementation((bin, args, opts, cb) => cb(err, '', ''));

      await expect(executePrompt('test', { timeout: 5000 }))
        .rejects.toThrow('Claude Code timed out after 5000ms');
    });

    it('should use custom cwd', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, '{}', ''));

      await executePrompt('test', { cwd: '/tmp/project' });

      const opts = execFile.mock.calls[0][2];
      expect(opts.cwd).toBe('/tmp/project');
    });

    it('should pass allowedTools correctly', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, '{}', ''));

      await executePrompt('test', { allowedTools: ['Bash(git:*)', 'Edit'] });

      const args = execFile.mock.calls[0][1];
      expect(args).toContain('--allowedTools');
      expect(args).toContain('Bash(git:*)');
      expect(args).toContain('Edit');
    });
  });

  describe('checkHealth', () => {
    it('should return available when claude --version works', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(null, '2.1.68 (Claude Code)\n', ''));

      const result = await checkHealth();

      expect(result.available).toBe(true);
      expect(result.version).toBe('2.1.68 (Claude Code)');
      expect(result.bin).toBe('claude');
    });

    it('should return unavailable when claude is not found', async () => {
      execFile.mockImplementation((bin, args, opts, cb) => cb(new Error('ENOENT'), '', ''));

      const result = await checkHealth();

      expect(result.available).toBe(false);
      expect(result.version).toBeNull();
      expect(result.error).toBeDefined();
    });
  });
});
