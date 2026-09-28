const Encounter = require('../models/Encounter');
const SummaryJob = require('../models/SummaryJob');
const SummaryHistory = require('../models/summaryHistory');
const logger = require('../helper/logger');
const {
  MAX_RETRIES,
  SLA_MS,
  RETRY_BACKOFF_MS,
  STUCK_JOB_THRESHOLD_MS,
} = require('../helper/constants');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const jobMeta = (job) => ({
  jobId: job._id?.toString(),
  encounterId: job.encounterId,
  version: job.version,
  attempt: job.attempts,
});

const getEncounterVersion = async (encounterId) => {
  const encounter = await Encounter.findOne({ encounterId }).select('version').lean();
  return encounter?.version ?? null;
};

const isCurrentVersion = async (encounterId, version) => {
  const currentVersion = await getEncounterVersion(encounterId);
  return currentVersion !== null && currentVersion === version;
};

const upsertSummaryHistory = async ({
  encounterId,
  version,
  patientId,
  encounterType,
  summaryText,
  errorMessage,
  retryCount,
}) => {
  await SummaryHistory.updateOne(
    { encounterId, version },
    {
      $set: {
        patientId,
        encounterType,
        summaryText,
        errorMessage,
        retryCount,
        completedAt: new Date(),
      },
      $setOnInsert: { queuedAt: new Date() },
    },
    { upsert: true }
  );
};

const markEncounterSummaryCompleted = async (encounterId, version, summaryText) => {
  await Encounter.updateOne(
    { encounterId, version },
    {
      $set: {
        'latestSummaryData.summaryText': summaryText,
        'latestSummaryData.status': 'COMPLETED',
        'latestSummaryData.errorMessage': null,
        'latestSummaryData.completedAt': new Date(),
      },
    }
  );
};

const markEncounterSummaryFailed = async (encounterId, version, errorMessage) => {
  await Encounter.updateOne(
    { encounterId, version },
    {
      $set: {
        'latestSummaryData.status': 'FAILED',
        'latestSummaryData.errorMessage': errorMessage,
      },
    }
  );
};

const markEncounterSlaBreached = async (encounterId, version) => {
  await Encounter.updateOne(
    { encounterId, version, 'latestSummaryData.slaBreached': { $ne: true } },
    {
      $set: {
        'latestSummaryData.slaBreached': true,
        'latestSummaryData.slaBreachedAt': new Date(),
      },
    }
  );
};

/**
 * Finalize a job: always update SummaryJob + history.
 * Update Encounter only if this version is still current.
 */
const finalizeJob = async (job, { status, summaryText = null, errorMessage = null }) => {
  const retryCount = Math.max(0, job.attempts - 1);
  const current = await isCurrentVersion(job.encounterId, job.version);

  await SummaryJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status,
        summaryText,
        errorMessage,
        completedAt: new Date(),
        startedAt: null,
      },
    }
  );

  await upsertSummaryHistory({
    encounterId: job.encounterId,
    version: job.version,
    patientId: job.patientId,
    encounterType: job.encounterType,
    summaryText,
    errorMessage,
    retryCount,
  });

  if (current) {
    if (status === 'COMPLETED') {
      await markEncounterSummaryCompleted(job.encounterId, job.version, summaryText);
    } else if (status === 'FAILED') {
      await markEncounterSummaryFailed(job.encounterId, job.version, errorMessage);
    }
    logger.info('worker.finalize', 'Job finalized — encounter updated', {
      ...jobMeta(job),
      status,
      encounterUpdated: true,
    });
  } else {
    logger.info('worker.finalize', 'Job finalized — history only (not current version)', {
      ...jobMeta(job),
      status,
      encounterUpdated: false,
    });
  }
};

const sleepWithSlaTracking = async (encounterId, version, durationMs) => {
  const slaTimer =
    durationMs >= SLA_MS
      ? setTimeout(async () => {
          if (await isCurrentVersion(encounterId, version)) {
            await markEncounterSlaBreached(encounterId, version);
            await SummaryJob.updateOne(
              { encounterId, version, slaBreached: { $ne: true } },
              { $set: { slaBreached: true, slaBreachedAt: new Date() } }
            );
            logger.warn('worker.sla', 'SLA breached', { encounterId, version, slaMs: SLA_MS });
          }
        }, SLA_MS)
      : null;

  await sleep(durationMs);

  if (slaTimer) {
    clearTimeout(slaTimer);
  }
};

/**
 * Mock generate_summary — uses immutable transcription from the job snapshot.
 */
const generateSummary = async (transcription, encounterId, version) => {
  const startMs = Date.now();
  let delay = Math.floor(Math.random() * 10000) + 5000;
  const timedOut = delay > SLA_MS;

  if (timedOut) {
    delay = SLA_MS;
  }

  logger.info('worker.generate', 'Summary generation started', {
    encounterId,
    version,
    simulatedDelayMs: delay,
  });

  await sleepWithSlaTracking(encounterId, version, delay);

  const durationMs = Date.now() - startMs;

  if (timedOut) {
    logger.warn('worker.generate', 'Summary generation timed out', { encounterId, version, durationMs });
    return { success: false, errorMessage: 'Timeout generating summary text', durationMs };
  }

  logger.info('worker.generate', 'Summary generation completed', { encounterId, version, durationMs });
  return {
    success: true,
    summaryText: `Summary text of the payload whose length is ${transcription?.length ?? 0}`,
    durationMs,
  };
};

const recoverStuckJobs = async () => {
  const threshold = new Date(Date.now() - STUCK_JOB_THRESHOLD_MS);
  const result = await SummaryJob.updateMany(
    { status: 'PROCESSING', startedAt: { $lt: threshold } },
    { $set: { status: 'PENDING', startedAt: null } }
  );
  if (result.modifiedCount > 0) {
    logger.warn('worker.recovery', 'Stuck jobs recovered', {
      count: result.modifiedCount,
      thresholdMs: STUCK_JOB_THRESHOLD_MS,
    });
  }
};

const claimPendingJob = async () => {
  const now = new Date();
  const job = await SummaryJob.findOneAndUpdate(
    { status: 'PENDING', nextRetryAt: { $lte: now } },
    { $set: { status: 'PROCESSING', startedAt: now }, $inc: { attempts: 1 } },
    { sort: { nextRetryAt: 1, queuedAt: 1 }, new: true }
  );

  if (job) {
    logger.info('worker.claim', 'Job claimed', jobMeta(job));
  }

  return job;
};

const scheduleRetry = async (job, errorMessage) => {
  const retryCount = job.attempts - 1;

  await upsertSummaryHistory({
    encounterId: job.encounterId,
    version: job.version,
    patientId: job.patientId,
    encounterType: job.encounterType,
    summaryText: null,
    errorMessage,
    retryCount,
  });

  if (job.attempts > MAX_RETRIES) {
    logger.error('worker.retry', 'Max retries exhausted — job failed', {
      ...jobMeta(job),
      maxRetries: MAX_RETRIES,
      errorMessage,
    });
    await finalizeJob(job, { status: 'FAILED', errorMessage });
    return;
  }

  const backoff = RETRY_BACKOFF_MS[job.attempts - 1] ?? 8000;
  await SummaryJob.updateOne(
    { _id: job._id, status: 'PROCESSING' },
    {
      $set: {
        status: 'PENDING',
        errorMessage,
        startedAt: null,
        nextRetryAt: new Date(Date.now() + backoff),
      },
    }
  );

  logger.info('worker.retry', 'Retry scheduled', {
    ...jobMeta(job),
    backoffMs: backoff,
    errorMessage,
  });
};

const processSummaryJob = async (job) => {
  const startMs = Date.now();
  logger.info('worker.process', 'Job processing started', jobMeta(job));

  try {
    const result = await generateSummary(job.transcription, job.encounterId, job.version);

    if (!result.success) {
      await scheduleRetry(job, result.errorMessage);
      return;
    }

    await finalizeJob(job, { status: 'COMPLETED', summaryText: result.summaryText });

    logger.info('worker.process', 'Job processing finished', {
      ...jobMeta(job),
      outcome: 'COMPLETED',
      durationMs: Date.now() - startMs,
    });
  } catch (error) {
    logger.error('worker.process', 'Job processing error', {
      ...jobMeta(job),
      errorMessage: error.message,
      durationMs: Date.now() - startMs,
    });
    await scheduleRetry(job, error.message || 'Error generating summary text');
  }
};

const createSummaryJob = async (
  { encounterId, version, patientId, encounterType, transcription },
  session = null
) => {
  const options = session ? { session } : {};
  const [job] = await SummaryJob.create(
    [
      {
        encounterId,
        version,
        patientId,
        encounterType,
        transcription,
        status: 'PENDING',
        attempts: 0,
        nextRetryAt: new Date(),
      },
    ],
    options
  );

  if (!session) {
    logger.info('worker.queue', 'SummaryJob created', {
      jobId: job._id.toString(),
      encounterId,
      version,
    });
  }
};

const pollAndProcessJobs = async () => {
  let job = await claimPendingJob();
  let processedCount = 0;

  while (job) {
    await processSummaryJob(job);
    processedCount += 1;
    job = await claimPendingJob();
  }

  if (processedCount > 0) {
    logger.info('worker.poll', 'Poll cycle completed', { jobsProcessed: processedCount });
  }
};

module.exports = {
  recoverStuckJobs,
  pollAndProcessJobs,
  createSummaryJob,
};
