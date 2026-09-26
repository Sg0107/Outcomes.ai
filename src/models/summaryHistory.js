const mongoose = require('mongoose');

const summaryHistorySchema = new mongoose.Schema({
    patientId: { type: String, required: true },
    encounterType: { type: String, required: true },
    encounterId: { type: String, required: true },
    version: { type: Number, required: true },
    summaryText: { type: String, required: true },
    errorMessage: { type: String, default: null },
    queuedAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
});

// create unique index on encounterId and version
summaryHistorySchema.index({ encounterId: 1, version: 1 }, { unique: true });



const SummaryHistory = mongoose.model('SummaryHistory', summaryHistorySchema);

module.exports = SummaryHistory;