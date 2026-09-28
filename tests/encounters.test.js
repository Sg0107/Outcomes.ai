const request = require('supertest');
const app = require('../src/app');
const SummaryJob = require('../src/models/SummaryJob');
const SummaryHistory = require('../src/models/summaryHistory');
const {
  recoverStuckJobs,
  processSummaryJob,
  setTestGenerateSummaryImpl,
  resetTestGenerateSummaryImpl,
} = require('../src/services/summaryWorkerService');
const { connectTestDb, disconnectTestDb, clearCollections } = require('./helpers/db');
const { buildEvent, successGenerateSummary, failGenerateSummary, resetEventCounter } = require('./helpers/fixtures');
const { drainWorker, waitForSummaryStatus } = require('./helpers/worker');

beforeAll(async () => {
  await connectTestDb();
}, 120000);

afterAll(async () => {
  await disconnectTestDb();
}, 30000);

beforeEach(async () => {
  await clearCollections();
  resetEventCounter();
  resetTestGenerateSummaryImpl();
  setTestGenerateSummaryImpl(successGenerateSummary);
});

describe('Encounter ingest and summary worker', () => {
  test('accepts v1 and completes summary for current version', async () => {
    const event = buildEvent({ version: 1 });

    const ingest = await request(app).post('/v1/encounters/events').send(event);
    expect(ingest.status).toBe(201);
    expect(ingest.body.code).toBe('ACCEPTED');

    const { encounterId } = ingest.body.data;
    const summary = await waitForSummaryStatus(app, encounterId, 'COMPLETED');

    expect(summary.summaryText).toContain('Summary text of the payload');
    expect(summary.status).toBe('COMPLETED');
  });

  test('returns DUPLICATE when the same eventId is sent twice', async () => {
    const event = buildEvent({ eventId: 'evt-dup-1', version: 1 });

    const first = await request(app).post('/v1/encounters/events').send(event);
    const second = await request(app).post('/v1/encounters/events').send(event);

    expect(first.status).toBe(201);
    expect(first.body.code).toBe('ACCEPTED');
    expect(second.status).toBe(200);
    expect(second.body.code).toBe('DUPLICATE');
  });

  test('accepts v12 and ignores stale v11 after v10', async () => {
    const base = buildEvent({ version: 10 });

    const first = await request(app).post('/v1/encounters/events').send(base);
    expect(first.status).toBe(201);
    const { encounterId } = first.body.data;

    const v12 = await request(app)
      .post('/v1/encounters/events')
      .send(buildEvent({ encounterId, version: 12 }));
    expect(v12.status).toBe(201);
    expect(v12.body.code).toBe('ACCEPTED');

    const v11 = await request(app)
      .post('/v1/encounters/events')
      .send(buildEvent({ encounterId, version: 11 }));
    expect(v11.status).toBe(200);
    expect(v11.body.code).toBe('STALE_IGNORED');
  });

  test('handles concurrent duplicate ingest with a single accept', async () => {
    const event = buildEvent({ eventId: 'evt-concurrent-1', version: 1 });

    const [first, second] = await Promise.all([
      request(app).post('/v1/encounters/events').send(event),
      request(app).post('/v1/encounters/events').send(event),
    ]);

    const statuses = [first.status, second.status].sort();
    const codes = [first.body.code, second.body.code].sort();

    expect(statuses).toEqual([200, 201]);
    expect(codes).toEqual(['ACCEPTED', 'DUPLICATE']);
  });

  test('recovers a stuck PROCESSING job after crash and completes it', async () => {
    const event = buildEvent({ version: 1 });

    const ingest = await request(app).post('/v1/encounters/events').send(event);
    expect(ingest.status).toBe(201);
    const { encounterId } = ingest.body.data;

    const job = await SummaryJob.findOne({ encounterId, version: 1 });
    expect(job).toBeTruthy();

    await SummaryJob.updateOne(
      { _id: job._id },
      { $set: { status: 'PROCESSING', startedAt: new Date(Date.now() - 3 * 60 * 1000) } }
    );

    await recoverStuckJobs();

    const recovered = await SummaryJob.findById(job._id);
    expect(recovered.status).toBe('PENDING');

    const summary = await waitForSummaryStatus(app, encounterId, 'COMPLETED');
    expect(summary.status).toBe('COMPLETED');
  });

  test('does not let an older version summary become current when a newer version exists', async () => {
    const v1Event = buildEvent({ version: 1 });
    const ingestV1 = await request(app).post('/v1/encounters/events').send(v1Event);
    expect(ingestV1.status).toBe(201);
    const { encounterId } = ingestV1.body.data;

    await waitForSummaryStatus(app, encounterId, 'COMPLETED');

    const ingestV12 = await request(app)
      .post('/v1/encounters/events')
      .send(buildEvent({ encounterId, version: 12 }));
    expect(ingestV12.status).toBe(201);

    const v12Job = await SummaryJob.findOne({ encounterId, version: 12 });
    await SummaryJob.updateOne(
      { _id: v12Job._id },
      { $set: { status: 'PROCESSING', startedAt: new Date(), attempts: 1 } }
    );

    const ingestV13 = await request(app)
      .post('/v1/encounters/events')
      .send(buildEvent({ encounterId, version: 13 }));
    expect(ingestV13.status).toBe(201);

    const staleV12Job = await SummaryJob.findOne({ encounterId, version: 12 });
    await processSummaryJob(staleV12Job);

    const encounterSummary = await request(app).get(`/v1/encounters/${encounterId}/summary`);
    expect(encounterSummary.body.data.status).toBe('PENDING');
    expect(encounterSummary.body.data.summaryText).toBeNull();

    const history = await SummaryHistory.findOne({ encounterId, version: 12 });
    expect(history.summaryText).toContain('Summary text of the payload');
  });

  test('marks job FAILED after retry exhaustion', async () => {
    setTestGenerateSummaryImpl(failGenerateSummary);

    const event = buildEvent({ version: 1 });
    const ingest = await request(app).post('/v1/encounters/events').send(event);
    expect(ingest.status).toBe(201);
    const { encounterId } = ingest.body.data;

    const job = await SummaryJob.findOne({ encounterId, version: 1 });

    for (let attempt = 0; attempt <= 4; attempt += 1) {
      const current = await SummaryJob.findById(job._id);
      if (current.status === 'FAILED') break;
      if (current.status === 'PENDING') {
        await SummaryJob.updateOne(
          { _id: job._id },
          { $set: { nextRetryAt: new Date(0) } }
        );
      }
      await drainWorker(1);
    }

    const failedJob = await SummaryJob.findById(job._id);
    expect(failedJob.status).toBe('FAILED');

    const summary = await request(app).get(`/v1/encounters/${encounterId}/summary`);
    expect(summary.body.data.status).toBe('FAILED');
  });
});
