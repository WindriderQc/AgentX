import { createCoreFinanceClient } from '../../../integrations/openclaw/finance-ledger/core-finance.js';

const read = createCoreFinanceClient({ baseUrl: process.argv[2] });
console.log(JSON.stringify(await read(JSON.parse(process.argv[3]))));
