const Encounter = require('../models/Encounter');
const ProcessedEvent = require('../models/ProcessedEvent');
const SummaryHistory = require('../models/summaryHistory');
const mongoose = require('mongoose');
const logger = require('../helper/logger');
const { createSummaryJob } = require('./summaryWorkerService');

const buildPendingSummaryData = () => ({
  status: 'PENDING',
  summaryText: null,
  errorMessage: null,
  queuedAt: new Date(),
  completedAt: null,
  slaBreached: false,
  slaBreachedAt: null,
});

const isTransientTransactionError = (err) =>
  err?.errorLabels?.includes('TransientTransactionError') ||
  err?.message?.includes('Please retry your operation') ||
  err?.message?.includes('catalog changes');

const runAcceptanceTransaction = async ({
  eventId,
  encounterId,
  version,
  patientId,
  encounterType,
  transcription,
  isNewEncounter,
}) => {
  const session = await mongoose.startSession();
  const txnMeta = { eventId, encounterId, version, isNewEncounter };

  logger.info('ingest.transaction', 'Transaction started', txnMeta);

  try {
    session.startTransaction();

    await ProcessedEvent.create(
      [{ eventId, encounterId, version, patientId, encounterType }],
      { session }
    );
    logger.info('ingest.transaction', 'ProcessedEvent inserted', txnMeta);

    if (isNewEncounter) {
      await Encounter.create(
        [
          {
            eventId,
            encounterId,
            patientId,
            encounterType,
            version,
            transcription,
            latestSummaryData: buildPendingSummaryData(),
          },
        ],
        { session }
      );
      logger.info('ingest.transaction', 'Encounter created', txnMeta);
    } else {
      const updateResult = await Encounter.updateOne(
        { encounterId, version: { $lt: version } },
        {
          $set: {
            version,
            transcription,
            latestSummaryData: buildPendingSummaryData(),
          },
        },
        { session }
      );

      if (updateResult.modifiedCount === 0) {
        logger.warn('ingest.transaction', 'Encounter update skipped — stale version race', txnMeta);
        await session.abortTransaction();
        return { stale: true };
      }
      logger.info('ingest.transaction', 'Encounter updated', txnMeta);
    }

    await createSummaryJob(
      { encounterId, version, patientId, encounterType, transcription },
      session
    );
    logger.info('ingest.transaction', 'SummaryJob queued', txnMeta);

    await session.commitTransaction();
    logger.info('ingest.transaction', 'Transaction committed', txnMeta);
    return { ok: true };
  } catch (err) {
    await session.abortTransaction();
    if (err.code === 11000) {
      logger.warn('ingest.transaction', 'Transaction aborted — duplicate key', { ...txnMeta, errorCode: err.code });
      return { duplicate: true };
    }
    throw err;
  } finally {
    session.endSession();
  }
};

/**
 * Atomically record ProcessedEvent, update/create Encounter, and queue SummaryJob.
 */
const commitAcceptedEvent = async (params) => {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runAcceptanceTransaction(params);
    } catch (err) {
      if (isTransientTransactionError(err) && attempt < maxAttempts) {
        logger.warn('ingest.transaction', 'Transient transaction error — retrying', {
          eventId: params.eventId,
          encounterId: params.encounterId,
          attempt,
          errorMessage: err.message,
        });
        continue;
      }
      logger.error('ingest.transaction', 'Transaction aborted — unexpected error', {
        eventId: params.eventId,
        encounterId: params.encounterId,
        errorMessage: err.message,
      });
      throw err;
    }
  }

  return { duplicate: true };
};

/**
 * Process incoming encounter event with versioning and idempotency checks.
 */
const processEncounter = async (eventData) => {
  const { eventId, patientId, version, encounterType, payload, encounterId } = eventData;

  logger.info('ingest', 'Event received', {
    eventId,
    encounterId: encounterId ?? null,
    version,
    encounterType,
    isNewEncounter: !encounterId,
  });

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
    logger.info('ingest', 'Duplicate event ignored', { eventId, code: 'DUPLICATE' });
    return { status: 200, code: 'DUPLICATE', message: 'Duplicate event ignored' };
  }

  if (encounterId) {
    const encounter = await Encounter.findOne({ encounterId });
    if (!encounter) {
      logger.warn('ingest', 'Encounter not found', { eventId, encounterId, code: 'NOT_FOUND' });
      return { status: 404, code: 'NOT_FOUND', message: 'Encounter not found' };
    }

    if (encounter.patientId !== patientId) {
      logger.warn('ingest', 'Patient ID mismatch', { eventId, encounterId, code: 'IDENTITY_MISMATCH' });
      const error = new Error('Patient ID mismatch for existing Encounter ID');
      error.status = 422;
      throw error;
    }

    if (encounter.encounterType !== encounterType) {
      logger.warn('ingest', 'Encounter type mismatch', { eventId, encounterId, code: 'IDENTITY_MISMATCH' });
      const error = new Error('Encounter type mismatch for existing Encounter ID');
      error.status = 422;
      throw error;
    }

    if (version <= encounter.version) {
      logger.info('ingest', 'Stale version ignored', {
        eventId,
        encounterId,
        version,
        storedVersion: encounter.version,
        code: 'STALE_IGNORED',
      });
      return { status: 200, code: 'STALE_IGNORED', message: 'Stale version ignored' };
    }

    const result = await commitAcceptedEvent({
      eventId,
      encounterId,
      version,
      patientId,
      encounterType,
      transcription: payload.transcription,
      isNewEncounter: false,
    });

    if (result.duplicate) {
      logger.info('ingest', 'Duplicate event ignored (transaction)', { eventId, encounterId, code: 'DUPLICATE' });
      return { status: 200, code: 'DUPLICATE', message: 'Duplicate event ignored' };
    }
    if (result.stale) {
      logger.info('ingest', 'Stale version ignored (transaction)', { eventId, encounterId, code: 'STALE_IGNORED' });
      return { status: 200, code: 'STALE_IGNORED', message: 'Stale version ignored' };
    }

    logger.info('ingest', 'Event accepted', { eventId, encounterId, version, code: 'ACCEPTED' });
    return {
      status: 201,
      code: 'ACCEPTED',
      message: 'Encounter event accepted for processing',
      data: { encounterId, version },
    };
  }

  const generatedEncounterId = new mongoose.Types.ObjectId().toString();

  const result = await commitAcceptedEvent({
    eventId,
    encounterId: generatedEncounterId,
    version,
    patientId,
    encounterType,
    transcription: payload.transcription,
    isNewEncounter: true,
  });

  if (result.duplicate) {
    logger.info('ingest', 'Duplicate event ignored (transaction)', {
      eventId,
      encounterId: generatedEncounterId,
      code: 'DUPLICATE',
    });
    return { status: 200, code: 'DUPLICATE', message: 'Duplicate event ignored' };
  }

  logger.info('ingest', 'Event accepted — new encounter', {
    eventId,
    encounterId: generatedEncounterId,
    version,
    code: 'ACCEPTED',
  });
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
  logger.info('summary.read', 'Summary status requested', { encounterId });

  const encounter = await Encounter.findOne({ encounterId }).select('latestSummaryData version').lean();
  if (!encounter) {
    logger.warn('summary.read', 'Encounter not found', { encounterId });
    const error = new Error('Encounter not found');
    error.status = 404;
    throw error;
  }

  logger.info('summary.read', 'Summary status returned', {
    encounterId,
    version: encounter.version,
    status: encounter.latestSummaryData?.status,
    slaBreached: encounter.latestSummaryData?.slaBreached ?? false,
  });

  return encounter.latestSummaryData;
};

/**
 * Get summary history for a patient, optionally filtered by encounter type or encounter id
 */
const getSummaryHistory = async (patientId, encounterType, encounterId) => {
  logger.info('summary.history', 'Summary history requested', {
    patientId,
    encounterType: encounterType ?? null,
    encounterId: encounterId ?? null,
  });

  const query = { patientId };
  if (encounterType) query.encounterType = encounterType;
  if (encounterId) query.encounterId = encounterId;

  const summaryHistory = await SummaryHistory.find(query);
  if (summaryHistory.length === 0) {
    logger.info('summary.history', 'No history found', { patientId, code: 'NOT_FOUND' });
    return { status: 404, code: 'NOT_FOUND', message: 'Summary history not found' };
  }

  const summaryHistoryData = summaryHistory.map((item) => ({
    encounterId: item.encounterId,
    version: item.version,
    summaryText: item.summaryText,
    errorMessage: item.errorMessage,
  }));

  logger.info('summary.history', 'Summary history returned', {
    patientId,
    rowCount: summaryHistoryData.length,
  });

  return {
    status: 200,
    code: 'SUCCESS',
    message: 'Summary history fetched successfully',
    data: summaryHistoryData,
  };
};

module.exports = {
  processEncounter,
  getEncounterSummary,
  getSummaryHistory,
};
