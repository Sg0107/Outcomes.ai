const { processEncounter } = require('../services/encounterService');

const processEvent = async (eventData) => {
  try {
    const result = await processEncounter(eventData);
    return result;
  } catch (error) {
    console.error('Error processing event:', error);
    return { status: 500, code: 'ERROR', message: error.message || 'Error processing event', data: null };
  }
}

module.exports = processEvent;