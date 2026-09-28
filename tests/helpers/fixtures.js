let eventCounter = 0;

const nextEventId = () => {
  eventCounter += 1;
  return `evt-test-${eventCounter}`;
};

const buildEvent = (overrides = {}) => ({
  eventId: nextEventId(),
  patientId: 'pat-test-1',
  encounterType: 'Appointment',
  version: 1,
  payload: { transcription: 'Nurse: Good morning. Patient: I feel fine.' },
  ...overrides,
});

const successGenerateSummary = () => ({
  success: true,
  summaryText: 'Summary text of the payload whose length is 42',
  durationMs: 1,
});

const failGenerateSummary = () => ({
  success: false,
  errorMessage: 'Timeout generating summary text',
  durationMs: 1,
});

module.exports = {
  buildEvent,
  successGenerateSummary,
  failGenerateSummary,
  resetEventCounter: () => {
    eventCounter = 0;
  },
};
