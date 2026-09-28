const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;

const syncAllIndexes = async () => {
  const Encounter = require('../../src/models/Encounter');
  const ProcessedEvent = require('../../src/models/ProcessedEvent');
  const SummaryJob = require('../../src/models/SummaryJob');
  const SummaryHistory = require('../../src/models/summaryHistory');

  await Promise.all([
    Encounter.syncIndexes(),
    ProcessedEvent.syncIndexes(),
    SummaryJob.syncIndexes(),
    SummaryHistory.syncIndexes(),
  ]);
};

const connectTestDb = async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await syncAllIndexes();
};

const disconnectTestDb = async () => {
  await mongoose.disconnect();
  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
};

const clearCollections = async () => {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
};

module.exports = {
  connectTestDb,
  disconnectTestDb,
  clearCollections,
};
