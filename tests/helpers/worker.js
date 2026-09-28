const request = require('supertest');
const { pollAndProcessJobs } = require('../../src/services/summaryWorkerService');

const drainWorker = async (iterations = 5) => {
  for (let i = 0; i < iterations; i += 1) {
    await pollAndProcessJobs();
  }
};

const waitForSummaryStatus = async (app, encounterId, expectedStatus, maxAttempts = 20) => {
  for (let i = 0; i < maxAttempts; i += 1) {
    await drainWorker(1);
    const res = await request(app).get(`/v1/encounters/${encounterId}/summary`);
    if (res.body.data?.status === expectedStatus) {
      return res.body.data;
    }
  }
  throw new Error(`Timed out waiting for summary status ${expectedStatus} on ${encounterId}`);
};

module.exports = {
  drainWorker,
  waitForSummaryStatus,
};
