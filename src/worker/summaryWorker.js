const { WORKER_POLL_INTERVAL_MS } = require('../helper/constants');
const logger = require('../helper/logger');
const { recoverStuckJobs, pollAndProcessJobs } = require('../services/summaryWorkerService');

let pollTimer = null;
let isPolling = false;

const tick = async () => {
  if (isPolling) return;
  isPolling = true;
  try {
    await pollAndProcessJobs();
  } catch (error) {
    logger.error('worker.poll', 'Poll cycle error', { errorMessage: error.message });
  } finally {
    isPolling = false;
  }
};

const startSummaryWorker = async () => {
  logger.info('worker', 'Summary worker starting', { pollIntervalMs: WORKER_POLL_INTERVAL_MS });
  await recoverStuckJobs();
  await tick();
  pollTimer = setInterval(tick, WORKER_POLL_INTERVAL_MS);
  logger.info('worker', 'Summary worker started', { pollIntervalMs: WORKER_POLL_INTERVAL_MS });
};

const stopSummaryWorker = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('worker', 'Summary worker stopped');
  }
};

module.exports = { startSummaryWorker, stopSummaryWorker };
