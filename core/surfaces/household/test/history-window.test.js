'use strict';

// #261: Core inference history is a block window. Its first message moves once
// every block of turns instead of on every turn, so the prompt prefix behind
// it stays identical (and cached) in between.

const assert = require('node:assert/strict');
const test = require('node:test');
const { PACKS } = require('../packs');
const { historyWindow, sessionHistoryMessages } = require('../persona-records');

// The newest-first rows a conversation of `count` turns returns, as loadSessionAuditRows does.
const rowsOf = (count, limit) => Array.from({ length: count }, (_, index) => ({
  inputText: `question ${index}`, replyText: `answer ${index}` })).reverse().slice(0, limit);
const historyAt = (pack, count) => sessionHistoryMessages(rowsOf(count, Math.ceil(pack.historyTurns / 2)), pack, { turnCount: count });

const SIZES = [...new Set([...PACKS.map(pack => pack.historyTurns), 1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 16])];

test('the block is half the turn window and the window never exceeds the pack maximum', () => {
  assert.deepEqual(PACKS.map(pack => [pack.id, pack.historyTurns, historyWindow(pack, 0).turns, historyWindow(pack, 0).block]),
    [['personal_operator', 8, 4, 2], ['kidx_nestor', 4, 2, 1], ['kidx_reader', 2, 1, 1]]);
  assert.deepEqual(historyWindow({ historyTurns: 0 }, 9), { turns: 0, block: 1, start: 0, visible: 0 });
  for (const historyTurns of SIZES) {
    const { turns, block } = historyWindow({ historyTurns }, 0);
    assert.equal(block, Math.max(1, Math.ceil(historyTurns / 4)));
    assert.ok(block <= turns && turns * 2 <= Math.max(2, historyTurns));
  }
});

test('the visible history start changes at most once every block of turns, deterministically', () => {
  for (const historyTurns of SIZES) {
    const pack = { historyTurns, historyMessageCharacters: 200 };
    const { turns, block } = historyWindow(pack, 0);
    let previous = historyWindow(pack, 0), sinceChange = Infinity;
    for (let count = 1; count <= 60; count += 1) {
      const current = historyWindow(pack, count);
      assert.deepEqual(current, historyWindow(pack, count), 'a pure function of the turn count');
      assert.ok(current.visible <= turns, 'never more turns than today');
      assert.ok(current.visible >= Math.min(count, turns - block + 1), 'at least the newer half stays visible');
      assert.equal(current.start % block, 0);
      if (current.start === previous.start) sinceChange += 1;
      else {
        assert.equal(current.start, previous.start + block, 'one whole block leaves at a time');
        assert.ok(sinceChange >= block || previous.start === 0, `historyTurns ${historyTurns}: the start moved again after ${sinceChange} turns`);
        sinceChange = 1;
      }
      previous = current;
    }
  }
});

test('between two block changes each prompt history extends the previous one', () => {
  for (const pack of [...PACKS, { historyTurns: 12, historyMessageCharacters: 200 }, { historyTurns: 5, historyMessageCharacters: 200 }]) {
    let changes = 0;
    for (let count = 0; count < 40; count += 1) {
      const now = historyAt(pack, count), next = historyAt(pack, count + 1);
      assert.ok(now.length <= pack.historyTurns && next.length <= pack.historyTurns, 'never more messages than the pack maximum');
      if (count) assert.equal(now.at(-1).content, `answer ${count - 1}`, 'the latest exchange is always visible');
      const window = historyWindow(pack, count), following = historyWindow(pack, count + 1);
      if (following.start === window.start) assert.deepEqual(next.slice(0, now.length), now, 'the earlier history is an identical prefix');
      else changes += 1;
      assert.equal(now[0]?.content, count ? `question ${window.start}` : undefined);
    }
    const { turns, block } = historyWindow(pack, 0);
    assert.ok(changes <= Math.ceil((40 - turns) / block) + 1);
  }
  // Super Dad: eight messages at most, and the start moves every second turn.
  const personal = PACKS.find(pack => pack.id === 'personal_operator');
  assert.deepEqual(Array.from({ length: 11 }, (_, count) => historyWindow(personal, count).start), [0, 0, 0, 0, 0, 2, 2, 4, 4, 6, 6]);
  assert.deepEqual(Array.from({ length: 11 }, (_, count) => historyAt(personal, count).length), [0, 2, 4, 6, 8, 6, 8, 6, 8, 6, 8]);
});

test('without a turn count the newest turns that fit are returned, as session resume expects', () => {
  const pack = { historyTurns: 8, historyMessageCharacters: 200 };
  const sliding = sessionHistoryMessages(rowsOf(9, 4), pack);
  assert.equal(sliding.length, 8);
  assert.equal(sliding[0].content, 'question 5');
  // A count lower than the rows actually read never hides them.
  assert.equal(sessionHistoryMessages(rowsOf(3, 4), pack, { turnCount: 0 }).length, 6);
});
