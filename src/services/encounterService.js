const Encounter = require('../models/Encounter');
const ProcessedEvent = require('../models/ProcessedEvent');
const SummaryHistory = require('../models/summaryHistory');
const mongoose = require('mongoose');
const { MAX_RETRIES, SLA_MS, RETRY_BACKOFF_MS } = require('../helper/constants');

const buildPendingSummaryData = () => ({
  status: 'PENDING',
  summaryText: null,
  errorMessage: null,
  queuedAt: new Date(),
  completedAt: null,
  slaBreached: false,
  slaBreachedAt: null,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const recordProcessedEvent = async ({ eventId, encounterId, version, patientId, encounterType }) => {
  try {
    await ProcessedEvent.create({ eventId, encounterId, version, patientId, encounterType });
    return { duplicate: false };
  } catch (err) {
    if (err.code === 11000) {
      return { duplicate: true };
    }
    throw err;
  }
};

const getEncounterVersion = async (encounterId) => {
  const encounter = await Encounter.findOne({ encounterId }).select('version').lean();
  return encounter?.version ?? null;
};

const isStaleJob = async (encounterId, version) => {
  const currentVersion = await getEncounterVersion(encounterId);
  return currentVersion === null || currentVersion > version;
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

const markSummaryCompleted = async (encounterId, version, summaryText) => {
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

const markSummaryFailed = async (encounterId, version, errorMessage) => {
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

const markSlaBreached = async (encounterId, version) => {
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

const sleepWithSlaTracking = async (encounterId, version, durationMs) => {
  const slaTimer =
    durationMs >= SLA_MS
      ? setTimeout(async () => {
          if (!(await isStaleJob(encounterId, version))) {
            await markSlaBreached(encounterId, version);
          }
        }, SLA_MS)
      : null;

  await sleep(durationMs);

  if (slaTimer) {
    clearTimeout(slaTimer);
  }
};

/**
 * Process incoming encounter event with versioning and idempotency checks.
 */
const processEncounter = async (eventData) => {
  const { eventId, patientId, version, encounterType, payload, encounterId } = eventData;
  if (!eventId) {
    return { status: 400, code: 'BAD_REQUEST', message: 'Event ID is required' };
  }
  if (!patientId) {
    return { status: 400, code: 'BAD_REQUEST', message: 'Patient ID is required' };
  }
  if (!version) {
    return { status: 400, code: 'BAD_REQUEST', message: 'Version is required' };
  }
  if (!encounterType) {
    return { status: 400, code: 'BAD_REQUEST', message: 'Encounter type is required' };
  }
  if (!payload) {
    return { status: 400, code: 'BAD_REQUEST', message: 'Payload is required' };
  }

  const existingEvent = await ProcessedEvent.findOne({ eventId }).lean();
  if (existingEvent) {
    return { status: 200, code: 'DUPLICATE', message: 'Duplicate event ignored' };
  }

  if (encounterId) {
    const encounter = await Encounter.findOne({ encounterId });
    if (!encounter) {
      return { status: 404, code: 'NOT_FOUND', message: 'Encounter not found' };
    }

    if (encounter.patientId !== patientId) {
      const error = new Error('Patient ID mismatch for existing Encounter ID');
      error.status = 422;
      throw error;
    }

    if (encounter.encounterType !== encounterType) {
      const error = new Error('Encounter type mismatch for existing Encounter ID');
      error.status = 422;
      throw error;
    }

    if (version <= encounter.version) {
      return { status: 200, code: 'STALE_IGNORED', message: 'Stale version ignored' };
    }

    const processed = await recordProcessedEvent({
      eventId,
      encounterId,
      version,
      patientId,
      encounterType,
    });
    if (processed.duplicate) {
      return { status: 200, code: 'DUPLICATE', message: 'Duplicate event ignored' };
    }

    await Encounter.updateOne(
      { encounterId },
      {
        $set: {
          version,
          transcription: payload.transcription,
          latestSummaryData: buildPendingSummaryData(),
        },
      }
    );

    generateSummaryText(payload, encounterId, version, patientId, encounterType);

    return {
      status: 201,
      code: 'ACCEPTED',
      message: 'Encounter event accepted for processing',
      data: { encounterId, version },
    };
  }

  const generatedEncounterId = new mongoose.Types.ObjectId().toString();

  const processed = await recordProcessedEvent({
    eventId,
    encounterId: generatedEncounterId,
    version,
    patientId,
    encounterType,
  });
  if (processed.duplicate) {
    return { status: 200, code: 'DUPLICATE', message: 'Duplicate event ignored' };
  }

  const encounter = new Encounter({
    eventId,
    encounterId: generatedEncounterId,
    patientId,
    encounterType,
    version,
    transcription: payload.transcription,
    latestSummaryData: buildPendingSummaryData(),
  });
  await encounter.save();

  generateSummaryText(payload, generatedEncounterId, version, patientId, encounterType);

  return {
    status: 201,
    code: 'ACCEPTED',
    message: 'Encounter event accepted for processing',
    data: { encounterId: generatedEncounterId, version },
  };
};

/**
 * Retrieve latest summary status for an encounter
 */
const getEncounterSummary = async (encounterId) => {
  const encounter = await Encounter.findOne({ encounterId }).select('latestSummaryData').lean();
  if (!encounter) {
    const error = new Error('Encounter not found');
    error.status = 404;
    throw error;
  }
  return encounter.latestSummaryData;
};

/**
 * Get summary history for a patient, optionally filtered by encounter type or encounter id
 */
const getSummaryHistory = async (patientId, encounterType, encounterId) => {
  const query = { patientId };
  if (encounterType) query.encounterType = encounterType;
  if (encounterId) query.encounterId = encounterId;

  const summaryHistory = await SummaryHistory.find(query);
  if (summaryHistory.length === 0) {
    return { status: 404, code: 'NOT_FOUND', message: 'Summary history not found' };
  }

  const summaryHistoryData = summaryHistory.map((item) => ({
    encounterId: item.encounterId,
    version: item.version,
    summaryText: item.summaryText,
    errorMessage: item.errorMessage,
  }));

  return {
    status: 200,
    code: 'SUCCESS',
    message: 'Summary history fetched successfully',
    data: summaryHistoryData,
  };
};

/**
 * Generate summary text from payload
 */
const generateSummaryText = async (payload, encounterId, version, patientId, encounterType, retryCount = 0) => {
  try {
    if (await isStaleJob(encounterId, version)) {
      return;
    }

    let timeout = Math.floor(Math.random() * 10000) + 5000;
    const simulatedTimeout = timeout > SLA_MS;

    if (simulatedTimeout) {
      timeout = SLA_MS;
    }

    await sleepWithSlaTracking(encounterId, version, timeout);

    if (await isStaleJob(encounterId, version)) {
      return;
    }

    if (simulatedTimeout) {
      const errorMessage = 'Timeout generating summary text';
      await upsertSummaryHistory({
        encounterId,
        version,
        patientId,
        encounterType,
        summaryText: null,
        errorMessage,
        retryCount,
      });

      if (retryCount >= MAX_RETRIES) {
        await markSummaryFailed(encounterId, version, errorMessage);
        return;
      }

      await sleep(RETRY_BACKOFF_MS[retryCount] ?? 8000);
      return generateSummaryText(payload, encounterId, version, patientId, encounterType, retryCount + 1);
    }

    const summaryText = `Summary text of the payload whose length is ${payload?.transcription?.length}`;

    if (await isStaleJob(encounterId, version)) {
      await upsertSummaryHistory({
        encounterId,
        version,
        patientId,
        encounterType,
        summaryText,
        errorMessage: null,
        retryCount,
      });
      return;
    }

    await markSummaryCompleted(encounterId, version, summaryText);
    await upsertSummaryHistory({
      encounterId,
      version,
      patientId,
      encounterType,
      summaryText,
      errorMessage: null,
      retryCount,
    });
  } catch (error) {
    console.error('Error generating summary text:', error);
  }
};

module.exports = {
  processEncounter,
  getEncounterSummary,
  getSummaryHistory,
};
