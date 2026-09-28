const Encounter = require('../models/Encounter');
const SummaryJob = require('../models/SummaryJob');
const SummaryHistory = require('../models/summaryHistory');
const {
  MAX_RETRIES,
  SLA_MS,
  RETRY_BACKOFF_MS,
  STUCK_JOB_THRESHOLD_MS,
} = require('../helper/constants');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  if (await isCurrentVersion(job.encounterId, job.version)) {
    if (status === 'COMPLETED') {
      await markEncounterSummaryCompleted(job.encounterId, job.version, summaryText);
    } else if (status === 'FAILED') {
      await markEncounterSummaryFailed(job.encounterId, job.version, errorMessage);
    }
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
  let delay = Math.floor(Math.random() * 10000) + 5000;
  const timedOut = delay > SLA_MS;

  if (timedOut) {
    delay = SLA_MS;
  }

  await sleepWithSlaTracking(encounterId, version, delay);

  if (timedOut) {
    return { success: false, errorMessage: 'Timeout generating summary text' };
  }

  return {
    success: true,
    summaryText: `Summary text of the payload whose length is ${transcription?.length ?? 0}`,
  };
};

const recoverStuckJobs = async () => {
  const threshold = new Date(Date.now() - STUCK_JOB_THRESHOLD_MS);
  const result = await SummaryJob.updateMany(
    { status: 'PROCESSING', startedAt: { $lt: threshold } },
    { $set: { status: 'PENDING', startedAt: null } }
  );
  if (result.modifiedCount > 0) {
    console.log(`Recovered ${result.modifiedCount} stuck summary job(s)`);
  }
};

const claimPendingJob = async () => {
  const now = new Date();
  return SummaryJob.findOneAndUpdate(
    { status: 'PENDING', nextRetryAt: { $lte: now } },
    { $set: { status: 'PROCESSING', startedAt: now }, $inc: { attempts: 1 } },
    { sort: { nextRetryAt: 1, queuedAt: 1 }, new: true }
  );
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
};

const processSummaryJob = async (job) => {
  try {
    const result = await generateSummary(job.transcription, job.encounterId, job.version);

    if (!result.success) {
      await scheduleRetry(job, result.errorMessage);
      return;
    }

    await finalizeJob(job, { status: 'COMPLETED', summaryText: result.summaryText });
  } catch (error) {
    console.error('Error processing summary job:', {
      jobId: job._id,
      encounterId: job.encounterId,
      version: job.version,
      error: error.message,
    });
    await scheduleRetry(job, error.message || 'Error generating summary text');
  }
};

const createSummaryJob = async ({ encounterId, version, patientId, encounterType, transcription }) => {
  await SummaryJob.create({
    encounterId,
    version,
    patientId,
    encounterType,
    transcription,
    status: 'PENDING',
    attempts: 0,
    nextRetryAt: new Date(),
  });
};

const pollAndProcessJobs = async () => {
  let job = await claimPendingJob();
  while (job) {
    await processSummaryJob(job);
    job = await claimPendingJob();
  }
};

module.exports = {
  recoverStuckJobs,
  pollAndProcessJobs,
  createSummaryJob,
};
