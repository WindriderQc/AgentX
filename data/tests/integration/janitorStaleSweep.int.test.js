/**
 * Integration test (REAL MongoDB) for the janitor startup sweep. The unit mock
 * does not model a filter on a field inside the proposed_actions array, nor the
 * positional `proposed_actions.<n>.<field>` update; a real server does.
 *
 * The test launcher supplies its own disposable MongoDB and database name.
 */
const { MongoClient } = require('mongodb');
const janitorRunner = require('../../services/janitorRunner');

const URI = process.env.MONGODB_URI_TEST;
const TEST_DB = URI ? new URL(URI).pathname.slice(1) : '';

if (!URI || !TEST_DB.startsWith('agentx_data_test_')) throw new Error('Run the Data test launcher with its disposable MongoDB.');

describe('janitor stale sweep (integration, real Mongo)', () => {
  let client;
  let coll;

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 });
    await client.connect();
    coll = client.db(TEST_DB).collection(janitorRunner.COLLECTION);
  });

  afterAll(async () => {
    if (coll) { try { await coll.deleteMany({}); } catch { /* best-effort cleanup */ } }
    if (client) await client.close();
  });

  test('stops running runs and returns executing actions to pending, touching nothing else', async () => {
    const untouched = { status: 'executed', files: ['/mnt/datalake/a.txt'], approval_preview: { id: 'p0', status: 'consumed' } };
    const { insertedIds } = await coll.insertMany([
      { status: 'running', finished_at: null, proposed_actions: [] },
      {
        status: 'complete',
        proposed_actions: [
          untouched,
          { status: 'executing', files: ['/mnt/datalake/dup.txt'], execution_authorized: true, approval_preview: { id: 'p1', status: 'ready' } }
        ]
      }
    ]);

    await expect(janitorRunner.sweepStaleRuns(client.db(TEST_DB))).resolves.toBe(1);

    const stopped = await coll.findOne({ _id: insertedIds[0] });
    expect(stopped.status).toBe('stopped');
    expect(stopped.finished_at).toBeInstanceOf(Date);

    const run = await coll.findOne({ _id: insertedIds[1] });
    expect(run.status).toBe('complete');
    expect(run.proposed_actions[0]).toEqual(untouched);
    expect(run.proposed_actions[1]).toMatchObject({
      status: 'pending',
      execution_authorized: false,
      files: ['/mnt/datalake/dup.txt'],
      approval_preview: { id: 'p1', status: 'invalidated' },
      result: { note: expect.stringMatching(/Generate a new preview/) }
    });
    expect(run.proposed_actions[1].execution_interrupted_at).toBeInstanceOf(Date);

    // A second start finds nothing left to repair.
    await expect(janitorRunner.sweepStaleRuns(client.db(TEST_DB))).resolves.toBe(0);
    expect(await coll.findOne({ _id: insertedIds[1] })).toEqual(run);
  });
});
