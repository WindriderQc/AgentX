'use strict';

/**
 * Island runs (Clawblox free-play experiment, arXiv 2610.07130): the typed
 * heavy-work executor shared by Core's queue contract, the operator CLI and
 * Benchmark's Île tab. A queued request names an agent and a duration; it
 * never carries a command, a host address, a token or a model name. The
 * agent always thinks through Core's principal alias.
 */

const ISLAND_MODE = 'island';
const PRINCIPAL_ALIAS = 'agentx-primary';
const RECEIPT_CONTRACT = 'agentx.operator-heavy-work/v1';
const RUNNER_CONTRACT = 'agentx.island-runner/v1';
const MIN_MINUTES = 5;
const MAX_MINUTES = 720;
// World start, agent stop and release proof around the agent's own time.
const OVERHEAD_MINUTES = 10;
const MEMORY_MODES = Object.freeze(['continue', 'fresh']);
// The coding harness that plays: Codex (default), DeepSeek Harness or pi. All
// three think with the principal alias through the run's capability relay.
const HARNESSES = Object.freeze(['codex', 'dsh', 'pi']);
const MEMORY_FILES = Object.freeze(['SOUL.md', 'EPISODIC_MEMORY.jsonl', 'SEMANTIC_MEMORY.md']);
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const WORLD = /^[a-z0-9][a-z0-9-]{0,63}$/;

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'HEAVY_QUEUE_INVALID' });
}

function isIslandExecutor(executor) {
  return Boolean(executor) && executor.mode === ISLAND_MODE;
}

/** Validate an island executor; returns it with defaults made explicit. */
function islandExecutor(executor) {
  if (!executor || typeof executor !== 'object' || Array.isArray(executor)) throw invalid('island executor required');
  const allowed = ['mode', 'receiptRef', 'agent', 'minutes', 'memory', 'world', 'harness'];
  if (Object.keys(executor).some(key => !allowed.includes(key))) throw invalid('island executor contains unsupported fields');
  if (executor.mode !== ISLAND_MODE) throw invalid('island executor needs mode "island"');
  const receiptRef = executor.receiptRef;
  if (typeof receiptRef !== 'string' || !receiptRef.trim() || receiptRef.length > 500 || /[\x00-\x1f\x7f]/.test(receiptRef)) {
    throw invalid('island executor needs an out-of-Git receiptRef');
  }
  const agent = executor.agent === undefined ? 'Eko' : executor.agent;
  if (typeof agent !== 'string' || !NAME.test(agent)) throw invalid('island agent needs a short name (letters, digits, - or _)');
  const minutes = executor.minutes;
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    throw invalid(`island minutes needs ${MIN_MINUTES} to ${MAX_MINUTES}`);
  }
  const memory = executor.memory === undefined ? 'continue' : executor.memory;
  if (!MEMORY_MODES.includes(memory)) throw invalid('island memory needs continue or fresh');
  const world = executor.world === undefined ? 'mesa-island' : executor.world;
  if (typeof world !== 'string' || !WORLD.test(world)) throw invalid('island world needs a world directory name');
  const harness = executor.harness === undefined ? 'codex' : executor.harness;
  if (!HARNESSES.includes(harness)) throw invalid('island harness needs codex, dsh or pi');
  return { mode: ISLAND_MODE, receiptRef: receiptRef.trim(), agent, minutes, memory, world, harness };
}

/** The queue time an island run needs: its own minutes plus start and release. */
function islandEstimatedMinutes(minutes) {
  return minutes + OVERHEAD_MINUTES;
}

module.exports = {
  ISLAND_MODE, PRINCIPAL_ALIAS, RECEIPT_CONTRACT, RUNNER_CONTRACT, MIN_MINUTES, MAX_MINUTES,
  OVERHEAD_MINUTES, MEMORY_MODES, MEMORY_FILES, HARNESSES, isIslandExecutor, islandExecutor, islandEstimatedMinutes
};
