const { WORKER_POLL_INTERVAL_MS } = require('../helper/constants');
const { recoverStuckJobs, pollAndProcessJobs } = require('../services/summaryWorkerService');

let pollTimer = null;
let isPolling = false;

const tick = async () => {
  if (isPolling) return;
  isPolling = true;
  try {
    await pollAndProcessJobs();
  } catch (error) {
    console.error('Summary worker poll error:', error.message);
  } finally {
    isPolling = false;
  }
};

const startSummaryWorker = async () => {
  await recoverStuckJobs();
  await tick();
  pollTimer = setInterval(tick, WORKER_POLL_INTERVAL_MS);
  console.log(`Summary worker started (poll every ${WORKER_POLL_INTERVAL_MS}ms)`);
};

const stopSummaryWorker = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

module.exports = { startSummaryWorker, stopSummaryWorker };
