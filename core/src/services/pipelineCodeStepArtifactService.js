'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const GRAPH_ID = /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const STEP_ID = /^step-(?:0[1-9]|1[0-6])$/;
const ARTIFACT_ID = /^code-step-[a-f0-9]{40}$/;

class PipelineCodeStepArtifactError extends Error {
  constructor(message, code = 'CODE_STEP_ARTIFACT_INVALID', statusCode = 400) {
    super(message);
    this.name = 'PipelineCodeStepArtifactError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(message, code, statusCode) {
  throw new PipelineCodeStepArtifactError(message, code, statusCode);
}

function identity(input) {
  if (!input || typeof input !== 'object' || !/^\d{4}$/.test(input.pipelineId || '')
    || !GRAPH_ID.test(input.graphId || '') || !STEP_ID.test(input.stepId || '')
    || !UUID.test(input.requestId || '')) fail('Invalid code-step artifact identity.');
  return Object.freeze({ pipelineId: input.pipelineId, graphId: input.graphId,
    stepId: input.stepId, requestId: input.requestId });
}

function artifactId(owner) {
  const material = [owner.pipelineId, owner.graphId, owner.stepId, owner.requestId].join('\0');
  return `code-step-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 40)}`;
}

function payload(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (!bytes.length) fail('The Git bundle is empty.');
  if (bytes.length > MAX_BYTES) fail('The Git bundle exceeds 8 MiB.', 'CODE_STEP_ARTIFACT_TOO_LARGE', 413);
  const firstLine = bytes.subarray(0, Math.min(bytes.length, 80)).toString('ascii').split('\n', 1)[0];
  if (!/^# v[23] git bundle$/.test(firstLine)) fail('The artifact is not a Git bundle.');
  return bytes;
}

function createPipelineCodeStepArtifactService({ dir = process.env.AGENTX_CODE_STEP_ARTIFACT_DIR } = {}) {
  const root = typeof dir === 'string' && dir.trim() ? path.resolve(dir.trim()) : null;
  const unavailable = () => fail('Code-step artifact storage is not configured.', 'CODE_STEP_ARTIFACT_UNAVAILABLE', 503);
  const directoryFor = id => {
    if (!root) unavailable();
    if (!ARTIFACT_ID.test(id || '')) fail('Invalid code-step artifact id.');
    return path.join(root, id);
  };
  const fileFor = (id, suffix) => {
    return path.join(directoryFor(id), suffix === 'bundle' ? 'artifact.bundle' : 'metadata.json');
  };

  async function prepareRoot() {
    if (!root) unavailable();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
  }

  async function readMetadata(id) {
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(fileFor(id, 'json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') fail('Code-step artifact not found.', 'CODE_STEP_ARTIFACT_NOT_FOUND', 404);
      fail('Code-step artifact metadata is unavailable.', 'CODE_STEP_ARTIFACT_UNAVAILABLE', 503);
    }
    if (!metadata || metadata.id !== id || metadata.format !== 'git-bundle/v1'
      || !/^[a-f0-9]{64}$/.test(metadata.sha256 || '')
      || !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1 || metadata.sizeBytes > MAX_BYTES
      || artifactId(identity(metadata.owner)) !== id) {
      fail('Code-step artifact metadata failed validation.', 'CODE_STEP_ARTIFACT_UNAVAILABLE', 503);
    }
    return metadata;
  }

  async function read(id) {
    await prepareRoot();
    const metadata = await readMetadata(id);
    let bytes;
    try { bytes = await fs.readFile(fileFor(id, 'bundle')); }
    catch { fail('Code-step artifact bytes are unavailable.', 'CODE_STEP_ARTIFACT_UNAVAILABLE', 503); }
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== metadata.sizeBytes || digest !== metadata.sha256) {
      fail('Code-step artifact integrity check failed.', 'CODE_STEP_ARTIFACT_UNAVAILABLE', 503);
    }
    return { metadata, bytes };
  }

  async function store(input, value) {
    await prepareRoot();
    const owner = identity(input);
    const bytes = payload(value);
    const id = artifactId(owner);
    const metadata = { id, owner, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length, format: 'git-bundle/v1' };
    try {
      const existing = await read(id);
      if (existing.metadata.sha256 !== metadata.sha256 || existing.metadata.sizeBytes !== metadata.sizeBytes) {
        fail('This code-step request already stored a different artifact.', 'CODE_STEP_ARTIFACT_CONFLICT', 409);
      }
      return { ...existing.metadata, replayed: true };
    } catch (error) {
      if (error.code !== 'CODE_STEP_ARTIFACT_NOT_FOUND') throw error;
    }
    const finalDirectory = directoryFor(id);
    const temporaryDirectory = path.join(root, `.${id}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.mkdir(temporaryDirectory, { mode: 0o700 });
      await fs.writeFile(path.join(temporaryDirectory, 'artifact.bundle'), bytes, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(temporaryDirectory, 'metadata.json'), `${JSON.stringify(metadata)}\n`,
        { flag: 'wx', mode: 0o600 });
      // Renaming one populated directory makes bytes and metadata visible as
      // one immutable unit. A concurrent divergent writer cannot replace it.
      await fs.rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        const existing = await read(id);
        if (existing.metadata.sha256 === metadata.sha256 && existing.metadata.sizeBytes === metadata.sizeBytes) {
          return { ...existing.metadata, replayed: true };
        }
        fail('This code-step request already stored a different artifact.', 'CODE_STEP_ARTIFACT_CONFLICT', 409);
      }
      throw error;
    }
    return { ...metadata, replayed: false };
  }

  return Object.freeze({ enabled: Boolean(root), store, read });
}

let shared;
function defaultPipelineCodeStepArtifactService() {
  const dir = process.env.AGENTX_CODE_STEP_ARTIFACT_DIR || '';
  if (!shared || shared.dir !== dir) shared = { dir, service: createPipelineCodeStepArtifactService({ dir }) };
  return shared.service;
}

module.exports = { MAX_BYTES, PipelineCodeStepArtifactError, createPipelineCodeStepArtifactService,
  defaultPipelineCodeStepArtifactService };
