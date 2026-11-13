#!/usr/bin/env node
'use strict';
const recovery = require('../src/services/photos/photoIndexRecovery');
if (require.main === module && process.env.PHOTO_INDEX_RECOVERY_STDIN !== '1')
  recovery.main().catch(error => { console.error(error.code, error.message); process.exitCode = 1; });
module.exports = recovery;
