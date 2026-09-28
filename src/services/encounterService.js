const Encounter = require('../models/Encounter');
const ProcessedEvent = require('../models/ProcessedEvent');
const SummaryHistory = require('../models/summaryHistory');
const mongoose = require('mongoose');
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

    await createSummaryJob({
      encounterId,
      version,
      patientId,
      encounterType,
      transcription: payload.transcription,
    });

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

  await createSummaryJob({
    encounterId: generatedEncounterId,
    version,
    patientId,
    encounterType,
    transcription: payload.transcription,
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

module.exports = {
  processEncounter,
  getEncounterSummary,
  getSummaryHistory,
};
