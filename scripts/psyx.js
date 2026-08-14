#!/usr/bin/env node
'use strict';

require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');
const {
  chat,
  getOrCreateState,
  toPlainState,
  remember,
  clearState
} = require('../src/services/psyxService');
const { PSYX_DEFAULT_MODEL } = require('../config/psyx');

const userId = process.env.PSYX_USER_ID || 'windrider';
const model = process.env.PSYX_MODEL || PSYX_DEFAULT_MODEL;
let conversationId = process.env.PSYX_CONVERSATION_ID || null;

function printHelp() {
  console.log(`
Commands:
  /help              Show commands
  /state             Show PsyX longitudinal state
  /remember <text>   Add an explicit durable note to PsyX state
  /new               Start a new conversation (state is preserved)
  /clear-state       Clear longitudinal PsyX state (conversation history is preserved)
  /exit               Quit
`);
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const state = await getOrCreateState(userId);
  if (!conversationId && state.lastConversationId) {
    conversationId = String(state.lastConversationId);
  }

  console.log('\nPsyX v0.1');
  console.log(`user:  ${userId}`);
  console.log(`model: ${model}`);
  console.log(conversationId ? `resume: ${conversationId}` : 'conversation: new');
  console.log('Type /help for commands.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You  > '
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    try {
      if (input === '/exit' || input === '/quit') {
        rl.close();
        return;
      }

      if (input === '/help') {
        printHelp();
        rl.prompt();
        return;
      }

      if (input === '/state') {
        const current = await getOrCreateState(userId);
        console.log(JSON.stringify(toPlainState(current), null, 2));
        console.log();
        rl.prompt();
        return;
      }

      if (input.startsWith('/remember ')) {
        const text = input.slice('/remember '.length).trim();
        await remember({ userId, text });
        console.log('PsyX > remembered.\n');
        rl.prompt();
        return;
      }

      if (input === '/new') {
        conversationId = null;
        console.log('PsyX > new conversation; longitudinal state preserved.\n');
        rl.prompt();
        return;
      }

      if (input === '/clear-state') {
        await clearState({ userId });
        console.log('PsyX > longitudinal state cleared; conversation history preserved.\n');
        rl.prompt();
        return;
      }

      process.stdout.write('PsyX > ');
      const result = await chat({
        userId,
        model,
        message: input,
        conversationId
      });
      conversationId = String(result.conversationId);
      console.log(`${result.response}\n`);
    } catch (err) {
      console.error(`\nPsyX ! ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    await mongoose.disconnect();
    console.log('\nPsyX offline.');
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error(`PsyX startup failed: ${err.message}`);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
