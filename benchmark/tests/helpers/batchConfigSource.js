'use strict';

const fs = require('fs');
const path = require('path');

const BENCHMARK_V2 = path.resolve(__dirname, '../../public/js/benchmark-v2');

// batch-config.js keeps the form; batch-config-launch.js holds the preflight
// display, submit and launch flow it wires. Tests read them as one source.
const BATCH_CONFIG_MODULES = ['batch-config.js', 'batch-config-launch.js'];

function readBatchConfigSource() {
    return BATCH_CONFIG_MODULES
        .map((file) => fs.readFileSync(path.join(BENCHMARK_V2, file), 'utf8'))
        .join('\n');
}

// The same source as one classic script for vm: imports and export lists
// removed, exported declarations kept as plain declarations.
function batchConfigScript() {
    return readBatchConfigSource()
        .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '')
        .replace(/^export \{[^}]*\};\r?\n/gm, '')
        .replace(/^export (?=(?:async )?function|const|let)/gm, '');
}

module.exports = { BATCH_CONFIG_MODULES, batchConfigScript, readBatchConfigSource };
