const encounterService = require('../services/encounterService');

const ingestEncounter = async (req, res, next) => {
  try {
    const { eventId, patientId, version, encounterType, payload, encounterId } = req.body;
    if (!eventId) {
        return res.status(400).json({ error: { message: 'Event ID is required' } });
    }
    if (!patientId) {
        return res.status(400).json({ error: { message: 'Patient ID is required' } });
    }
    if (!version) {
        return res.status(400).json({ error: { message: 'Version is required' } });
    }
    if (!encounterType) {
        return res.status(400).json({ error: { message: 'Encounter type is required' } });
    }
    if (!payload) {
        return res.status(400).json({ error: { message: 'Payload is required' } });
    }
    console.log("Data received:", { eventId, patientId, version, encounterType, payload, encounterId });

    // if (version !== 1) {
    //     if (!encounterId) {
    //         return res.status(400).json({ error: { message: 'Encounter ID is required' } });
    //     }
    // }
    
    const result = await encounterService.processEncounter({ eventId, patientId, version, encounterType, payload, encounterId });
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
