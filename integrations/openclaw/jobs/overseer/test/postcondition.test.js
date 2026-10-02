'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const postcondition = require('../openclaw-overseer-postcondition');
const { REPORT, transcriptJsonl } = require('./fixtures');

const SCRIPT = path.join(__dirname, '..', 'openclaw-overseer-postcondition.js');

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

function tempSessions() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-home-'));
  const sessions = path.join(home, 'agents', 'overseer', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return { home, sessions };
}

test('accepts a complete synthetic transcript', () => {
  const receipt = postcondition.verifyTranscriptText(transcriptJsonl());
  assert.equal(receipt.finalText, REPORT);
  assert.equal(receipt.finalTextSha256, postcondition.sha256Text(REPORT));
  assert.equal(receipt.snapshotHeader, 'schema-5/status-ok');
  assert.equal(receipt.toolCalls, 2);
  assert.equal(receipt.headings, 5);
});

test('rejects forbidden tools and missing headings', () => {
  assert.equal(codeOf(() => postcondition.verifyTranscriptText(
    transcriptJsonl({ extraCall: 'agentx__create_todo' }),
  )), 'forbidden-tool-call');
  assert.equal(codeOf(() => postcondition.verifyTranscriptText(
    transcriptJsonl({ report: REPORT.replace('## Architecture drift\n', '') }),
  )), 'final-report-headings-invalid');
  assert.equal(codeOf(() => postcondition.verifyTranscriptText('not json\n')), 'transcript-jsonl-invalid');
});

test('derives the sessions root from OPENCLAW_HOME or the user home', () => {
  assert.equal(
    postcondition.defaultSessionsRoot({ OPENCLAW_HOME: path.join('x', 'oc') }),
    path.join('x', 'oc', 'agents', 'overseer', 'sessions'),
  );
  assert.equal(
    postcondition.defaultSessionsRoot({}),
    path.join(os.homedir(), '.openclaw', 'agents', 'overseer', 'sessions'),
  );
  const options = postcondition.parseArgs(['--transcript', 'a.jsonl'], { OPENCLAW_HOME: 'oc' });
  assert.equal(options.sessionsRoot, path.join('oc', 'agents', 'overseer', 'sessions'));
  assert.equal(postcondition.parseArgs(['--transcript', 'a.jsonl'], {
    OPENCLAW_HOME: 'oc', OPENCLAW_OVERSEER_SESSIONS_ROOT: 'explicit',
  }).sessionsRoot, 'explicit');
  assert.equal(codeOf(() => postcondition.parseArgs([], {})), 'transcript-required');
  assert.equal(codeOf(() => postcondition.parseArgs(['--other'], {})), 'argument-invalid');
});

test('verifies a transcript file only inside the sessions root', () => {
  const { home, sessions } = tempSessions();
  try {
    const inside = path.join(sessions, `${randomUUID()}.jsonl`);
    fs.writeFileSync(inside, transcriptJsonl());
    assert.equal(postcondition.verifyTranscriptFile(inside, { sessionsRoot: sessions }).toolCalls, 2);
    const outside = path.join(home, `${randomUUID()}.jsonl`);
    fs.writeFileSync(outside, transcriptJsonl());
    assert.equal(codeOf(() => postcondition.verifyTranscriptFile(outside, { sessionsRoot: sessions })),
      'transcript-outside-sessions-root');
    const badName = path.join(sessions, 'report.jsonl');
    fs.writeFileSync(badName, transcriptJsonl());
    assert.equal(codeOf(() => postcondition.verifyTranscriptFile(badName, { sessionsRoot: sessions })),
      'transcript-name-invalid');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI prints its receipt line and failure code', () => {
  const { home, sessions } = tempSessions();
  try {
    const transcript = path.join(sessions, `${randomUUID()}.jsonl`);
    fs.writeFileSync(transcript, transcriptJsonl());
    const env = { ...process.env, OPENCLAW_HOME: home };
    delete env.OPENCLAW_OVERSEER_SESSIONS_ROOT;
    const ok = spawnSync(process.execPath, [SCRIPT, '--transcript', transcript], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(),
      'OVERSEER_POSTCONDITION_OK tools=2 snapshot_header=schema-5/status-ok headings=5');
    const bad = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr.trim(), 'OVERSEER_POSTCONDITION_FAILED code=transcript-required');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
