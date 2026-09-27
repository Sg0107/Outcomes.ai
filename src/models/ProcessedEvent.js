const mongoose = require('mongoose');

const processedEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    encounterId: { type: String, required: true },
    version: { type: Number, required: true },
    patientId: { type: String, required: true },
    encounterType: { type: String, required: true },
  },
  { timestamps: true }
);

processedEventSchema.index({ eventId: 1 }, { unique: true });
processedEventSchema.index({ encounterId: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('ProcessedEvent', processedEventSchema);
