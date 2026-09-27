const Encounter = require('../models/Encounter');
const SummaryHistory = require('../models/summaryHistory');
const mongoose = require('mongoose');
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
  console.log("Data received:", eventData);

  // 1. Check for duplicate event (Idempotency)
  const existingEvent = await Encounter.findOne({ eventId: eventId });
  if (existingEvent) {
    return { status: 200, code: 'DUPLICATE', message: 'Duplicate event ignored' };
  }
  console.log("Existing event not found");

  // 2. Retrieve existing encounter
  let encounter
  if (encounterId) {
    console.log("Checking for existing encounter:", { encounterId });
    encounter = await Encounter.findOne({ encounterId });
    console.log("Encounter found:", encounter);
    if (!encounter) {
      return { status: 404, code: 'NOT_FOUND', message: 'Encounter not found' };
    }
  } else {
    console.log("Creating new encounter");
    const generatedEncounterId = new mongoose.Types.ObjectId().toString();
    encounter = new Encounter({
      eventId,
      encounterId: generatedEncounterId,
      patientId,
      encounterType,
      version: version,
      transcription: payload.transcription,
      latestSummaryData: {
        status: 'PENDING',
        summaryText: null,
        errorMessage: null,
        queuedAt: Date.now(),
        completedAt: null
      }
    });
    await encounter.save();
    generateSummaryText(payload, generatedEncounterId, version, patientId, encounterType);
    return { status: 201, code: 'ACCEPTED', message: 'Encounter event accepted for processing', data: { encounterId: generatedEncounterId, version: version } };
  }

  console.log("checking patient id consistency and stale version");
  if (encounter) {
    // Validate Patient ID consistency
    if (encounter.patientId !== patientId) {
      const error = new Error('Patient ID mismatch for existing Encounter ID');
      error.status = 422;
      throw error;
    }

    // Encounter type is fixed for the life of the encounter, same as patientId
    if (encounter.encounterType !== encounterType) {
      const error = new Error('Encounter type mismatch for existing Encounter ID');
      error.status = 422;
      throw error;
    }

    // Check for stale event
    if (version <= encounter.version) {
      return { status: 200, code: 'STALE_IGNORED', message: 'Stale version ignored' };
    }
  }
  console.log("creating new encounter", { eventId, encounterId, patientId, version, encounterType, transcription : payload.transcription });
  // 3. update existing encounter
  await Encounter.updateOne({ encounterId: encounter.encounterId }, { $set: { 'version' : version, 'transcription' : payload.transcription } });

  // 4. Update Encounter and mark older older encounter as SUPERSEDED
  await Encounter.updateOne({ encounterId: encounter.encounterId }, { $set: { 'latestSummaryData.status' : 'SUPERSEDED', 'latestSummaryData.errorMessage' : 'Newer version of the encounter has been received' } });

  generateSummaryText(payload, encounter.encounterId, version, patientId, encounter.encounterType);

  return {
    status: 201,
    code: 'ACCEPTED',
    message: 'Encounter event accepted for processing',
    data: { encounterId, version: version }
  };
};

/**
 * Retrieve latest summary status for an encounter
 */
const getEncounterSummary = async (encounterId) => {
    try {
        const encounter = await Encounter.findOne({ encounterId: encounterId }).select('latestSummaryData').lean();
        if (!encounter) {
            const error = new Error('Encounter not found');
            error.status = 404;
            throw error;
        }
        console.log("Encounter found:", encounter);
        console.log("Latest summary data:", encounter.latestSummaryData);
        return encounter.latestSummaryData;
    } catch (error) {
        if (error.status === 404) {
            throw error;
        }
        const wrapped = new Error('Error getting encounter summary');
        wrapped.status = 500;
        throw wrapped;
    }
};

/**
 * Get summary history for a patient and encounter type
 */
const getSummaryHistory = async (patientId, encounterType, encounterId) => {
    try {
      const query = {patientId: patientId};
      if (encounterType) query.encounterType = encounterType;
      if (encounterId) query.encounterId = encounterId;
      const summaryHistory = await SummaryHistory.find(query);
      if (summaryHistory.length === 0) {
        return { status: 404, code: 'NOT_FOUND', message: 'Summary history not found' };
      }
      const summaryHistoryData = summaryHistory.map((item) => {
        return {
          encounterId: item.encounterId,
          version: item.version,
          summaryText: item.summaryText,
          errorMessage: item.errorMessage
        }
      });
      return { status: 200, code: 'SUCCESS', message: 'Summary history fetched successfully', data: summaryHistoryData };
    } catch (error) {
        error.message = 'Error getting summary history';
        error.status = 500;
        return { status: 500, code: 'ERROR', message: 'Error getting summary history', data: null };
    }
}

/**
 * Generate summary text from payload
 */
const generateSummaryText = async (payload, encounterId, version, patientId, encounterType) => {
  try {
      // set timeout here for a random number between 5-15sec, and if time exceeds 10 sec we will throw error
      let timeout = Math.floor(Math.random() * 10000) + 5000;
      console.log("Timeout:", timeout);
      if (timeout > 10000) {
          timeout = 10000;
          await new Promise(resolve => setTimeout(resolve, timeout));
          await Encounter.updateOne({ encounterId: encounterId, version: version }, 
            { $set: { 'latestSummaryData.status' : 'FAILED', 'latestSummaryData.errorMessage' : 'Timeout generating summary text' } });
          throw new Error('Timeout generating summary text');
      }
      console.log("Waiting for timeout:", timeout);
      await new Promise(resolve => setTimeout(resolve, timeout));
      console.log("Timeout completed");
      const summaryText = `Summary text of the payload whose length is ${payload?.transcription?.length}`;
      // using unqiue index on encounterId and version to update the summary text and status
      console.log("Updating encounter", { encounterId, version, summaryText, status: 'COMPLETED', completedAt: Date.now() });
      // do not update if version of existing encounter is greater than the version of the new encounter but still save in sumary history and mark as superseded
      const existingEncounter = await Encounter.findOne({ encounterId: encounterId }).select('version').lean();
      if (existingEncounter.version > version) {
        await SummaryHistory.create({ encounterId: encounterId, version: version, summaryText: summaryText, errorMessage: null, patientId: patientId, encounterType: encounterType });
        await Encounter.updateOne({ encounterId: encounterId }, { $set: { 'latestSummaryData.status' : 'SUPERSEDED', 'latestSummaryData.errorMessage' : 'Newer version of the encounter has been received' } });
        return { status: 200, code: 'STALE_IGNORED', message: 'Stale version ignored' };
      }
      await Encounter.updateOne({ encounterId: encounterId, version: version }, 
          { $set: { 'latestSummaryData.summaryText' : summaryText, 'latestSummaryData.status' : 'COMPLETED', 'latestSummaryData.completedAt' : Date.now() } });
      await SummaryHistory.create({ encounterId: encounterId, version: version, summaryText: summaryText, errorMessage: null, patientId: patientId, encounterType: encounterType });
  } catch (error) {
      console.error('Error generating summary text:', error);
      return { status: 500, code: 'ERROR', message: error.message || 'Error generating summary text', data: null };
  }
}

module.exports = {
  processEncounter,
  getEncounterSummary,
  getSummaryHistory
};
