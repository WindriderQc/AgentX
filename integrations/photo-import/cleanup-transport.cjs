'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { fail } = require('../../core/src/services/photos/importFiles');
const { id } = require('../../core/src/services/photos/phoneLibrary');

function createRemover(cache) {
  const remove = async (request, authorize) => {
    id(request.operationId);
    id(request.planId);
    id(request.item.requestId);
    const dir = path.join(cache, 'phone-cleanup', request.operationId, request.item.requestId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const resultFile = path.join(dir, 'result.json'),
      dispatchFile = path.join(dir, 'dispatch.json');
    try {
      return JSON.parse(await fs.readFile(resultFile, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      await fs.stat(dispatchFile);
      throw fail('CLEANUP_UNCERTAIN', 'An earlier USB deletion has no receipt; do not repeat it');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!request.item.objectId)
      throw fail('SOURCE_CHANGED', 'The selected phone source is absent or ambiguous');
    const attemptFile = path.join(dir, 'attempt.json');
    const binding = {
      operationId: request.operationId,
      planId: request.planId,
      digest: request.digest,
      requestId: request.item.requestId,
      sha256: request.item.sha256,
    };
    let attempt;
    try {
      attempt = JSON.parse(await fs.readFile(attemptFile, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const handle = await fs.open(attemptFile, 'wx', 0o600);
      try {
        attempt = { ...binding, attemptId: crypto.randomUUID() };
        await handle.writeFile(JSON.stringify(attempt));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (Object.keys(binding).some((key) => binding[key] !== attempt[key]))
      throw fail('REQUEST_CONFLICT', 'Native attempt belongs to another source');
    const input = path.join(dir, 'request-' + crypto.randomUUID() + '.json');
    const spool = path.join(dir, 'verify-' + crypto.randomUUID() + '.media');
    let child;
    try {
      // Another same-operation caller may have finished before this lock.
      try {
        return JSON.parse(await fs.readFile(resultFile, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      try {
        await fs.stat(dispatchFile);
        throw fail('CLEANUP_UNCERTAIN', 'The original dispatch still needs reconciliation');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      await fs.writeFile(
        input,
        JSON.stringify({ ...request, attemptId: attempt.attemptId, resultFile, dispatchFile, spool }),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(__dirname, 'cleanup.ps1'),
          '-RequestFile',
          input,
        ],
        { windowsHide: true },
      );
      let stderr = '',
        bytes = 0;
      child.stdin.on('error', () => {});
      child.stderr.on('data', (b) => {
        stderr = (stderr + b).slice(-4096);
      });
      const exit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      exit.catch(() => {});
      const timeout = setTimeout(() => child.kill(), 10 * 60 * 1000);
      try {
        let ready = false;
        for await (const line of readline.createInterface({ input: child.stdout })) {
          if ((bytes += Buffer.byteLength(line)) > 65536)
            throw fail('CLEANUP_UNCERTAIN', 'Invalid native response');
          const value = JSON.parse(line);
          if (value.ready) {
            if (ready) throw fail('CLEANUP_UNCERTAIN', 'Repeated native preflight');
            const grant = await authorize({ ...value, attemptId: attempt.attemptId });
            if (
              grant.operationId !== request.operationId ||
              grant.requestId !== request.item.requestId ||
              grant.digest !== request.digest ||
              grant.sha256 !== request.item.sha256 ||
              grant.attemptId !== attempt.attemptId
            )
              throw fail('INVALID_GRANT', 'Invalid Core deletion grant');
            if (child.exitCode !== null || child.killed)
              throw fail('CLEANUP_UNCERTAIN', 'Native preflight ended before the Core grant');
            ready = true;
            child.stdin.end('DELETE:' + request.operationId + ':' + attempt.attemptId + '\n');
          }
        }
        if ((await exit) !== 0)
          throw fail('CLEANUP_UNCERTAIN', stderr || 'Native cleanup stopped before its result');
        return JSON.parse(await fs.readFile(resultFile, 'utf8'));
      } catch (e) {
        child.kill();
        await exit.catch(() => {});
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await fs.rm(input, { force: true });
      await fs.rm(spool, { force: true });
    }
  };
  remove.reconcile = async (request) => {
    id(request.operationId);
    id(request.item.requestId);
    const dir = path.join(cache, 'phone-cleanup', request.operationId, request.item.requestId);
    try {
      return JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      await fs.stat(path.join(dir, 'dispatch.json'));
      throw fail('CLEANUP_UNCERTAIN', 'The original USB dispatch has no result; do not repeat deletion');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return null;
  };
  return remove;
}
module.exports = { createRemover };
