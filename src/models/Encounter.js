const mongoose = require('mongoose');

const summaryJobSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['PENDING', 'PROCESSING', 'READY', 'FAILED', 'SUPERSEDED'],
    default: 'PENDING'
  },
  summaryText: { type: String, default: null },
  errorMessage: { type: String, default: null },
  queuedAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
}, { _id: false });

const encounterSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    encounterId: { type: String, required: true },
    patientId: { type: String, required: true},
    encounterType: { type: String, required: true },
    version: { type: Number, required: true, default: 0 },
    transcription: { type: String, required: true },
    latestSummaryData: summaryJobSchema
  },
  { timestamps: true }
);

// create unique index on encounterId and version    
encounterSchema.index({ encounterId: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('Encounter', encounterSchema);
