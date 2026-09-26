const encounterService = require('../services/encounterService');

const ingestEncounter = async (req, res, next) => {
  try {
    const eventData = req.body;
    const result = await encounterService.processEncounter(eventData);
    return res.status(result.status).json(result);
  } catch (err) {
    next(err);
  }
};

const getSummary = async (req, res, next) => {
  try {
    const { encounterId } = req.params;
    const summaryData = await encounterService.getEncounterSummary(encounterId);
    return res.status(200).json({ data: summaryData });
  } catch (err) {
    next(err);
  }
};

const getSummaryHistory = async (req, res, next) => {
  try {
    const { patientId, encounterType, encounterId} = req.params;
    const summaryHistory = await encounterService.getSummaryHistory(patientId, encounterType, encounterId);
    return res.status(200).json(summaryHistory);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  ingestEncounter,
  getSummary,
  getSummaryHistory
};
