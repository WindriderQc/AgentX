'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describe } = require('../public/agent-activity');

test('Nestor names the agent it consults and waits for', () => {
  const name = id => ({ comptable: 'Comptable' })[id] || id;
  assert.deepEqual(describe({ kind: 'tool', tool: 'sessions_spawn', agentId: 'comptable' }, name), { text: 'J’envoie ta question à Comptable.', spoken: true });
  assert.deepEqual(describe({ kind: 'waiting_agent', agentId: 'comptable' }, name), { text: 'J’attends la réponse de Comptable. Ça peut prendre une minute.', spoken: true });
  assert.equal(describe({ kind: 'waiting_agent' }).spoken, true);
  assert.deepEqual(describe({ kind: 'tool', tool: 'image_generate' }), { text: 'Je crée l’image.', spoken: true });
  assert.equal(describe({ kind: 'waiting_image' }).spoken, false);
});

test('known tools are spoken, unknown tools stay quiet and yields say nothing', () => {
  assert.equal(describe({ kind: 'tool', tool: 'personal_memory' }).text, 'Je consulte tes notes.');
  assert.equal(describe({ kind: 'tool', tool: 'agentx__list_personal_tasks' }).text, 'Je regarde tes tâches.');
  assert.deepEqual(describe({ kind: 'tool', tool: 'exec' }), { text: 'Outil : exec', spoken: false });
  assert.equal(describe({ kind: 'tool', tool: 'sessions_yield' }), null);
  assert.equal(describe(null), null);
});

test('a turn handed to a team member is announced at once', () => {
  const name = id => ({ secretary: 'Secrétaire' })[id] || id;
  assert.deepEqual(describe({ kind: 'member_addressed', agentId: 'secretary' }, name), { text: 'Je passe ta question à Secrétaire.', spoken: true });
  assert.equal(describe({ kind: 'member_addressed' }).spoken, true);
});

test('mail, calendar and note searches are spoken', () => {
  for (const tool of ['gmail_secretary_search', 'gmail_secretary_read', 'mail_journal']) {
    assert.deepEqual(describe({ kind: 'tool', tool }), { text: 'Je cherche dans tes courriels.', spoken: true });
  }
  assert.equal(describe({ kind: 'tool', tool: 'calendar_list_events' }).text, 'Je regarde ton agenda.');
  assert.equal(describe({ kind: 'tool', tool: 'memory_search' }).text, 'Je cherche dans mes notes.');
});

test('storage, file and GPU reads are spoken', () => {
  for (const tool of ['nestor_storage', 'nestor_files']) {
    assert.deepEqual(describe({ kind: 'tool', tool }), { text: 'Je consulte l’index des fichiers.', spoken: true });
  }
  assert.deepEqual(describe({ kind: 'tool', tool: 'nestor_gpus' }), { text: 'Je regarde les cartes graphiques.', spoken: true });
  assert.deepEqual(describe({ kind: 'tool', tool: 'nestor_janitor_report' }), { text: 'Je lis le dernier rapport Janitor.', spoken: true });
});

function announcementsHarness() {
  let time = 0, nextId = 0;
  const timers = new Map(), lines = [];
  const policy = require('../public/agent-activity').createAnnouncements({
    now: () => time,
    setTimer(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); }
  });
  return {
    lines,
    begin(signal) { return policy.begin(line => lines.push(line), { signal }); },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      time = target;
    }
  };
}
const discoveryEvent = tool => ({ type: 'status', phase: 'activity', activity: { kind: 'tool', tool: tool || 'tool_search' } });

test('quick discovery never displays or speaks a notice', () => {
  const h = announcementsHarness(), turn = h.begin();
  turn.update(discoveryEvent()); h.advance(14_999);
  assert.deepEqual(h.lines, []);
  turn.update({ type: 'delta', delta: 'Voici la réponse.' }); h.advance(60_000);
  assert.deepEqual(h.lines, []);
});

test('slow discovery announces at 15 seconds despite repeated catalogue events', () => {
  const h = announcementsHarness(), turn = h.begin();
  turn.update(discoveryEvent()); h.advance(5_000);
  turn.update(discoveryEvent('tool_describe')); h.advance(5_000);
  turn.update(discoveryEvent('agents_list')); h.advance(4_999);
  assert.equal(h.lines.length, 0);
  h.advance(1);
  assert.deepEqual(h.lines, [{ text: 'Je regarde quels outils utiliser.', spoken: true }]);
  h.advance(300_000); turn.update(discoveryEvent()); h.advance(15_000);
  assert.equal(h.lines.length, 1, 'at most once in the same turn');
});

test('discovery cooldown survives subsequent user turns and expires after five minutes', () => {
  const h = announcementsHarness(), first = h.begin();
  first.update(discoveryEvent()); h.advance(15_000); first.end();
  const second = h.begin(); second.update(discoveryEvent()); h.advance(299_999); second.end();
  assert.equal(h.lines.length, 1);
  h.advance(1);
  const third = h.begin(); third.update(discoveryEvent()); h.advance(14_999);
  assert.equal(h.lines.length, 1);
  h.advance(1);
  assert.equal(h.lines.length, 2);
  third.end();
});

test('new activity cancels stale discovery without consuming its cooldown', () => {
  const h = announcementsHarness(), turn = h.begin();
  turn.update(discoveryEvent()); h.advance(5_000);
  turn.update(discoveryEvent('memory_search')); h.advance(20_000);
  assert.deepEqual(h.lines, [{ text: 'Je cherche dans mes notes.', spoken: true }]);
  turn.update(discoveryEvent()); h.advance(15_000);
  assert.equal(h.lines.at(-1).text, 'Je regarde quels outils utiliser.');
  turn.end();
});

test('completion, failure, speech end and stream cleanup cancel pending discovery', () => {
  for (const type of ['done', 'error', 'say_end', 'cleanup']) {
    const h = announcementsHarness(), turn = h.begin();
    turn.update(discoveryEvent()); h.advance(5_000);
    if (type === 'cleanup') turn.end(); else turn.update({ type });
    turn.update(discoveryEvent()); h.advance(60_000);
    assert.deepEqual(h.lines, [], type);
  }
});

test('abort cancels pending discovery and an already aborted turn stays silent', () => {
  for (const abortFirst of [false, true]) {
    const h = announcementsHarness(), controller = new AbortController();
    if (abortFirst) controller.abort();
    const turn = h.begin(controller.signal); turn.update(discoveryEvent()); h.advance(5_000);
    controller.abort(); h.advance(60_000);
    assert.deepEqual(h.lines, []);
    turn.end();
  }
});

test('resource waiting and quiet tool events supersede discovery', () => {
  for (const event of [{ type: 'status', phase: 'waiting_host' }, discoveryEvent('sessions_yield')]) {
    const h = announcementsHarness(), turn = h.begin();
    turn.update(discoveryEvent()); h.advance(5_000); turn.update(event); h.advance(60_000);
    assert.deepEqual(h.lines, []);
    turn.end();
  }
});


test('reply text suppresses later discovery while useful team notices remain immediate', () => {
  const h = announcementsHarness(), turn = h.begin();
  turn.update({ type: 'delta', delta: 'Je vais consulter mon équipe.' });
  turn.update(discoveryEvent()); h.advance(60_000);
  assert.deepEqual(h.lines, []);
  turn.update({ type: 'status', phase: 'activity', activity: { kind: 'member_addressed' } });
  assert.deepEqual(h.lines, [{ text: 'Je passe ta question à un autre agent.', spoken: true }]);
  turn.end();
});
