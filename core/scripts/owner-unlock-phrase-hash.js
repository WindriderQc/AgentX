#!/usr/bin/env node
'use strict';

// Prints the scrypt hash of the owner unlock phrase for the instance
// environment (HOUSEHOLD_OWNER_UNLOCK_PHRASE_HASH). The phrase is read from
// standard input and never written anywhere; keep the hash outside Git too.
//
//   read -rs phrase && printf %s "$phrase" | node scripts/owner-unlock-phrase-hash.js

const { hashPhrase } = require('../surfaces/household/owner-unlock');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    process.stdout.write(`${hashPhrase(input)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
});
