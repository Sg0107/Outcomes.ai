const mongoose = require('mongoose');

const summaryJobSchema = new mongoose.Schema(
  {
    encounterId: { type: String, required: true },
    version: { type: Number, required: true },
    patientId: { type: String, required: true },
    encounterType: { type: String, required: true },
    transcription: { type: String, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
    },
    attempts: { type: Number, default: 0 },
    nextRetryAt: { type: Date, default: Date.now },
    summaryText: { type: String, default: null },
    errorMessage: { type: String, default: null },
    queuedAt: { type: Date, default: Date.now },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    slaBreached: { type: Boolean, default: false },
    slaBreachedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

summaryJobSchema.index({ encounterId: 1, version: 1 }, { unique: true });
summaryJobSchema.index({ status: 1, nextRetryAt: 1 });

module.exports = mongoose.model('SummaryJob', summaryJobSchema);
