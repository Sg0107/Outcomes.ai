const express = require('express');
const router = express.Router();
const encounterController = require('../controllers/encounterController');

// POST /v1/encounters/events - Ingest clinical encounter events
router.post('/encounters/events', encounterController.ingestEncounter);

// GET /v1/encounters/:encounterId/summary - Fetch summary status & result
router.get('/encounters/:encounterId/summary', encounterController.getSummary);

// GET /v1/encounters/:patientId/summary-history - Fetch summary history
router.get('/encounters/:patientId/summary-history', encounterController.getSummaryHistory);
module.exports = router;
