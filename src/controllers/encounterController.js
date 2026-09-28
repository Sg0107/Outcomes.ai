const encounterService = require('../services/encounterService');
const logger = require('../helper/logger');

const ingestEncounter = async (req, res, next) => {
  try {
    const eventData = req.body;
    const result = await encounterService.processEncounter(eventData);
    logger.info('api.ingest', 'Ingest response sent', {
      eventId: eventData.eventId,
      httpStatus: result.status,
      code: result.code,
    });
    return res.status(result.status).json(result);
  } catch (err) {
    next(err);
  }
};

const getSummary = async (req, res, next) => {
  try {
    const { encounterId } = req.params;
    const summaryData = await encounterService.getEncounterSummary(encounterId);
    logger.info('api.summary', 'Summary response sent', {
      encounterId,
      status: summaryData?.status,
    });
    return res.status(200).json({ data: summaryData });
  } catch (err) {
    next(err);
  }
};

const getSummaryHistory = async (req, res, next) => {
  try {
    const { patientId } = req.params;
    const { encounterType, encounterId } = req.query;
    const summaryHistory = await encounterService.getSummaryHistory(patientId, encounterType, encounterId);
    logger.info('api.history', 'History response sent', {
      patientId,
      httpStatus: summaryHistory.status,
      code: summaryHistory.code,
    });
    return res.status(summaryHistory.status).json(summaryHistory);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  ingestEncounter,
  getSummary,
  getSummaryHistory
};
