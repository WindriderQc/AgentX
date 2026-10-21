// Synchronous Node preload: hydrate argv, then let Node run the CLI as main.
// Preserve its import.meta.main guard and top-level-await exit semantics.
const { readFileSync } = require('node:fs');
const file = process.argv[2];
if (!file) throw new Error('A private prompt file is required');
const prompt = readFileSync(file, 'utf8');
process.argv.splice(2, 1);
process.argv.push(prompt);
